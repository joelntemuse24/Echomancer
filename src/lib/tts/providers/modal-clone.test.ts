import { afterEach, describe, expect, it, vi } from "vitest";
import { openFishTtsStream } from "./fish";
import {
  ModalCloneColdError,
  ModalCloneProviderError,
  resetModalCloneRuntimeForTests,
  synthesizeModalClone,
  usesModalClone,
} from "./modal-clone";
import {
  MODAL_CLONE_COVER_ARGS,
  setModalCloneWarmSpawnerForTests,
} from "./modal-clone-warm";
import {
  BATCH_HOST,
  SINGLE_HOST,
  endpointOf,
  readyBody,
  stubModalEndpoints,
} from "./modal-endpoints.fixture";
import { queryOne } from "@/lib/turso";
import { downloadFile } from "@/lib/storage";

vi.mock("@/lib/turso", () => ({
  queryOne: vi.fn(),
  execute: vi.fn(async () => ({ rowsAffected: 1 })),
}));
vi.mock("@/lib/storage", () => ({ downloadFile: vi.fn() }));

const input = {
  text: "It is a truth universally acknowledged.",
  voiceId: "private-fish-id",
  catalogVoiceId: "clone:saved-id",
  model: "s2.1-pro-free",
};
const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0, 1]); // "ID3"
const longText = "word ".repeat(200);

function readyResponse(status = 200, body: unknown = readyBody()) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mp3Response(headers: Record<string, string> = { "x-s2-duration": "42.5" }) {
  return new Response(mp3, { headers });
}

function setup() {
  vi.stubEnv("CLONE_TTS_PROVIDER", "modal");
  stubModalEndpoints(vi.stubEnv);
  vi.stubEnv("MODAL_S2_TOKEN", "test-token");
  vi.stubEnv("FISH_API_KEY", "test-fish");
  vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter");
  vi.stubEnv("MODAL_S2_SAMPLING", "0.9,0.9");
  vi.mocked(queryOne).mockResolvedValue({
    sample_storage_path: "clones/saved/sample.wav",
    reference_transcript: "the spoken text of the sample",
    user_id: "user_a",
  });
  vi.mocked(downloadFile).mockResolvedValue(Buffer.from("reference audio"));
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (endpointOf(String(url)) === "ready") return readyResponse();
    return mp3Response();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function synthesizeCalls(fetchMock: ReturnType<typeof setup>) {
  return fetchMock.mock.calls.filter((call) => endpointOf(String(call[0])) === "single");
}

afterEach(() => {
  resetModalCloneRuntimeForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("modal clone routing", () => {
  it("claims clone voices only when the provider is modal", () => {
    vi.stubEnv("CLONE_TTS_PROVIDER", "");
    vi.stubEnv("MODAL_S2_TTS_URL", BATCH_HOST);
    expect(usesModalClone("clone:abc")).toBe(true);
    expect(usesModalClone("fish:abc")).toBe(false);
    vi.stubEnv("CLONE_TTS_PROVIDER", "modal");
    expect(usesModalClone("clone:abc")).toBe(true);
    vi.stubEnv("CLONE_TTS_PROVIDER", "openrouter");
    expect(usesModalClone("clone:abc")).toBe(false);
  });

  it("stands down when the endpoint is not configured", () => {
    vi.stubEnv("CLONE_TTS_PROVIDER", "");
    vi.stubEnv("MODAL_S2_TTS_URL", "");
    expect(usesModalClone("clone:abc")).toBe(false);
  });

  it("posts the section, reference and transcript to the container", async () => {
    const fetchMock = setup();
    const result = await synthesizeModalClone(input);

    expect(result.contentType).toBe("audio/mpeg");
    expect(result.durationHintSeconds).toBe(42.5);
    const call = synthesizeCalls(fetchMock)[0]!;
    // The single-section endpoint is its own host with nothing appended.
    expect(String(call[0])).toBe(SINGLE_HOST);
    expect((call[1]!.headers as Record<string, string>)["x-echomancer-token"]).toBe(
      "test-token"
    );
    const body = JSON.parse(String(call[1]!.body));
    expect(body.text).toBe(input.text);
    expect(body.reference_text).toBe("the spoken text of the sample");
    expect(body.sampling).toBe("0.9,0.9");
    expect(body.seed).toBeUndefined();
    expect(Buffer.from(body.reference_audio_base64, "base64").toString()).toBe(
      "reference audio"
    );
  });

  it("rejects a clone whose sample is missing", async () => {
    setup();
    vi.mocked(queryOne).mockResolvedValue({ sample_storage_path: null });
    await expect(synthesizeModalClone(input)).rejects.toThrow(/unavailable/);
  });

  it("rejects non-MP3 audio so the caller can fall back", async () => {
    const fetchMock = setup();
    fetchMock.mockImplementation(async (url) => {
      if (endpointOf(String(url)) === "ready") return readyResponse();
      return new Response(new Uint8Array([0, 1, 2, 3]));
    });
    await expect(synthesizeModalClone(input)).rejects.toThrow(/invalid MP3/);
  });

  it("surfaces the container's status and detail", async () => {
    const fetchMock = setup();
    fetchMock.mockImplementation(async (url) => {
      if (endpointOf(String(url)) === "ready") return readyResponse();
      return new Response("section is too large", { status: 422 });
    });
    await expect(synthesizeModalClone(input)).rejects.toThrow(/422[\s\S]*too large/);
  });

  it("uses a 30–60s call timeout", async () => {
    const fetchMock = setup();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await synthesizeModalClone(input);
    expect(timeout).toHaveBeenCalledWith(60_000);
    expect(timeout).toHaveBeenCalledWith(5_000);
    expect(synthesizeCalls(fetchMock)).toHaveLength(1);

    vi.stubEnv("MODAL_S2_TIMEOUT_MS", "45000");
    timeout.mockClear();
    await synthesizeModalClone({ ...input, text: "Another short line." });
    expect(timeout).toHaveBeenCalledWith(45_000);

    vi.stubEnv("MODAL_S2_TIMEOUT_MS", "180000");
    timeout.mockClear();
    await synthesizeModalClone({ ...input, text: "A third short line." });
    expect(timeout).toHaveBeenCalledWith(60_000);
  });

  it("parks the book when the probe says the container is cold", async () => {
    const fetchMock = setup();
    let readyCalls = 0;
    fetchMock.mockImplementation(async (url) => {
      if (endpointOf(String(url)) === "ready") {
        readyCalls += 1;
        return readyResponse(503, { ready: false, runners: 0 });
      }
      return mp3Response();
    });
    await expect(synthesizeModalClone(input)).rejects.toThrow(ModalCloneColdError);
    expect(synthesizeCalls(fetchMock)).toHaveLength(0);
    // The 30s backoff means the second call does not even probe.
    await expect(synthesizeModalClone(input)).rejects.toThrow(/cold/);
    expect(readyCalls).toBe(1);
  });

  it("still synthesizes when the probe route is not deployed", async () => {
    const fetchMock = setup();
    fetchMock.mockImplementation(async (url) => {
      if (endpointOf(String(url)) === "ready") return new Response("nope", { status: 404 });
      return mp3Response();
    });
    await synthesizeModalClone(input);
    expect(synthesizeCalls(fetchMock)).toHaveLength(1);
  });

  it("bounds a cold placement by the restore budget and kicks an RPC warm", async () => {
    const fetchMock = setup();
    vi.stubEnv("MODAL_S2_READY", "0");
    vi.stubEnv("MODAL_S2_COLD_WAIT_MS", String(16 * 60_000));
    vi.stubEnv("MODAL_TOKEN_ID", "test-token");
    const spawned: string[][] = [];
    setModalCloneWarmSpawnerForTests((command, args) => {
      spawned.push([command, ...args]);
    });
    fetchMock.mockImplementation(async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    });
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const error = await synthesizeModalClone(input).then(
      () => {
        throw new Error("expected a cold placement");
      },
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(ModalCloneColdError);
    expect((error as ModalCloneColdError).scope).toBe("placement");
    const waits = timeout.mock.calls.map((call) => call[0]);
    expect(waits).toContain(180_000);
    expect(Math.max(...waits)).toBeLessThan(8 * 60_000);
    expect(spawned).toEqual([["modal", ...MODAL_CLONE_COVER_ARGS]]);
    // The section spent its budget. The next call must not open another one.
    fetchMock.mockClear();
    await expect(synthesizeModalClone({ ...input, text: "Another short line." })).rejects.toThrow(
      /backoff/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips the probe when MODAL_S2_READY=0", async () => {
    const fetchMock = setup();
    vi.stubEnv("MODAL_S2_READY", "0");
    await synthesizeModalClone(input);
    expect(fetchMock.mock.calls.some((call) => endpointOf(String(call[0])) === "ready")).toBe(
      false
    );
    expect(synthesizeCalls(fetchMock)).toHaveLength(1);
  });

  it("retries a truncated take once with a new seed", async () => {
    const fetchMock = setup();
    let synth = 0;
    fetchMock.mockImplementation(async (url) => {
      if (endpointOf(String(url)) === "ready") return readyResponse();
      synth += 1;
      if (synth === 1) {
        return mp3Response({ "x-s2-duration": "4", "x-s2-truncated": "2" });
      }
      return mp3Response({ "x-s2-duration": "80", "x-s2-truncated": "0" });
    });
    const result = await synthesizeModalClone({ ...input, text: longText });
    expect(result.durationHintSeconds).toBe(80);
    const calls = synthesizeCalls(fetchMock);
    expect(calls).toHaveLength(2);
    const first = JSON.parse(String(calls[0]![1]!.body));
    const second = JSON.parse(String(calls[1]![1]!.body));
    // Epoch 0 for the first take, 1 for the retry, and an explicit seed so a
    // container build that predates seed_epoch still renders a fresh take.
    expect(first.seed_epoch).toBe(0);
    expect(first.seed).toBeUndefined();
    expect(second.seed_epoch).toBe(1);
    expect(second.seed).toEqual(expect.any(Number));
  });

  it("still calls Modal when the account has already generated far past every former cap", async () => {
    // The allowance is gone (2026-11-07). A ledger full of prior usage must not
    // stop a section: what may be generated is the provider account's business.
    // `job 75944dc9` was refused at 492,425 used + 17,022 requested against a
    // 500,000 daily cap, and the refusal looked like a provider fault.
    const fetchMock = setup();
    vi.stubEnv("MODAL_S2_USER_DAILY_CHARS", "1");
    vi.stubEnv("MODAL_S2_GLOBAL_DAILY_CHARS", "1");
    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (sql.includes("usage_logs")) {
        return { user_chars: 99_000_000, global_chars: 99_000_000 };
      }
      return {
        sample_storage_path: "clones/saved/sample.wav",
        reference_transcript: "the spoken text of the sample",
        user_id: "user_a",
      };
    });
    const result = await synthesizeModalClone(input);
    expect(result.contentType).toBe("audio/mpeg");
    expect(synthesizeCalls(fetchMock).length).toBeGreaterThan(0);
    // Nothing on this path reads the usage ledger to decide anything.
    for (const call of vi.mocked(queryOne).mock.calls) {
      expect(String(call[0])).not.toMatch(/FROM\s+usage_logs/i);
    }
    vi.unstubAllEnvs();
  });
});

describe("fish adapter fallback order", () => {
  it("surfaces a cold pool instead of switching narrator", async () => {
    const fetchMock = setup();
    fetchMock.mockImplementation(async (url) => {
      const href = String(url);
      if (endpointOf(href) === "ready") return readyResponse();
      if (endpointOf(href) === "single") throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      return mp3Response();
    });
    // An unpinned call (live listen) still falls through so the person hears
    // something; a pinned book parks instead. This is the pinned path.
    await expect(
      openFishTtsStream({ ...input, cloneProviderPin: "modal", allowFallback: false }, "balanced")
    ).rejects.toThrow(ModalCloneColdError);
    expect(synthesizeCalls(fetchMock)).toHaveLength(1);
    expect(
      fetchMock.mock.calls.some((call) =>
        String(call[0]).includes("openrouter.ai/api/v1/audio/speech")
      )
    ).toBe(false);
  });

  it("falls back to direct Fish, never Drama 3, for an unpinned live listen", async () => {
    const fetchMock = setup();
    fetchMock.mockImplementation(async (url) => {
      const href = String(url);
      if (endpointOf(href) === "ready") return readyResponse();
      if (endpointOf(href) === "single") throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      return mp3Response();
    });
    const res = await openFishTtsStream(input, "balanced");
    expect(synthesizeCalls(fetchMock)).toHaveLength(1);
    // Same clone voice: Fish is the account that trained the reference.
    expect(String(fetchMock.mock.calls.at(-1)![0])).toContain("api.fish.audio");
    expect(
      fetchMock.mock.calls.some((call) =>
        String(call[0]).includes("openrouter.ai")
      )
    ).toBe(false);
    // The Fish response is passed through as-is, so the bytes are the proof.
    expect(await res.arrayBuffer()).toEqual(mp3.buffer);
  });

  it("never substitutes a voice when an unpinned preview cannot reach any engine", async () => {
    const fetchMock = setup();
    vi.stubEnv("FISH_API_KEY", "");
    fetchMock.mockImplementation(async (url) => {
      const href = String(url);
      if (endpointOf(href) === "ready") return readyResponse();
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    });
    // No Modal, no Fish key, and no Drama rung: the call fails visibly.
    await expect(openFishTtsStream(input, "balanced")).rejects.toThrow();
    expect(
      fetchMock.mock.calls.some((call) =>
        String(call[0]).includes("openrouter.ai")
      )
    ).toBe(false);
  });

  it("falls back to direct Fish after one truncated take", async () => {
    const fetchMock = setup();
    fetchMock.mockImplementation(async (url) => {
      const href = String(url);
      if (endpointOf(href) === "ready") return readyResponse();
      if (endpointOf(href) === "single") {
        return mp3Response({ "x-s2-duration": "2", "x-s2-truncated": "1" });
      }
      return mp3Response();
    });
    const res = await openFishTtsStream({ ...input, text: longText }, "balanced");
    expect(synthesizeCalls(fetchMock)).toHaveLength(2);
    expect(String(fetchMock.mock.calls.at(-1)![0])).toContain("api.fish.audio");
    expect(await res.arrayBuffer()).toEqual(mp3.buffer);
  });

  it("does not call Modal when MODAL_S2_TTS_URL is unset", async () => {
    const fetchMock = setup();
    vi.stubEnv("MODAL_S2_TTS_URL", "");
    vi.stubEnv("CLONE_TTS_PROVIDER", "");
    const res = await openFishTtsStream(input, "balanced");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("api.fish.audio");
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain("modal.run");
    expect(await res.arrayBuffer()).toEqual(mp3.buffer);
  });

  it("uses Modal for a job with no allowance state at all", async () => {
    // A pinned job goes to Modal on configuration alone. Previously a blocked
    // job skipped Modal entirely and fell through to Fish, which is how a
    // refusal was reported as a provider failure.
    const fetchMock = setup();
    const res = await openFishTtsStream({ ...input, jobId: "job-1" }, "balanced");
    expect(synthesizeCalls(fetchMock).length).toBeGreaterThan(0);
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]).includes("api.fish.audio"))
    ).toBe(false);
    expect(await res.arrayBuffer()).toBeInstanceOf(ArrayBuffer);
  });
});

/**
 * The second half of the `job 5f09ee0e` incident.
 *
 * The container answered every lane with HTTP 500
 * (`TypeError: open() got an unexpected keyword argument 'metadata_errors'`).
 * Those 500s were retried as if they were transient, spent the section's whole
 * attempt ledger, and the book failed with "Section 0: Modal clone already
 * retried" — a status that names the retry policy instead of the real fault.
 *
 * A hard provider fault is now its own type, gets at most one extra take, and
 * the message that reaches the caller is the provider's.
 */
describe("Modal hard provider faults", () => {
  it("surfaces the provider's own message, never the retry ledger", async () => {
    const fetchMock = setup();
    fetchMock.mockImplementation(async (url) => {
      if (endpointOf(String(url)) === "ready") return readyResponse();
      return new Response(
        "Internal Server Error: TypeError: open() got an unexpected keyword argument 'metadata_errors'",
        { status: 500 }
      );
    });

    const first = await synthesizeModalClone(input).catch((err: unknown) => err);
    expect(first).toBeInstanceOf(ModalCloneProviderError);
    expect(String(first)).toContain("metadata_errors");
    expect(String(first)).not.toMatch(/already retried/);
    expect((first as ModalCloneProviderError).status).toBe(500);

    // A second call reports the same fault, not a spent-attempts status.
    const second = await synthesizeModalClone(input).catch((err: unknown) => err);
    expect(second).toBeInstanceOf(ModalCloneProviderError);
    expect(String(second)).toContain("500");
    expect(String(second)).not.toMatch(/already retried/);
  });

  it("retries a hard fault exactly once, then stops calling the container", async () => {
    const fetchMock = setup();
    fetchMock.mockImplementation(async (url) => {
      if (endpointOf(String(url)) === "ready") return readyResponse();
      return new Response("boom", { status: 500 });
    });

    // First call opens one request; the worker's own retry opens the second.
    await expect(synthesizeModalClone(input)).rejects.toBeInstanceOf(
      ModalCloneProviderError
    );
    expect(synthesizeCalls(fetchMock)).toHaveLength(1);
    await expect(synthesizeModalClone(input)).rejects.toBeInstanceOf(
      ModalCloneProviderError
    );
    expect(synthesizeCalls(fetchMock)).toHaveLength(2);
    // The budget is spent: no third request, and still the provider's message.
    const third = await synthesizeModalClone(input).catch((e: unknown) => e);
    expect(synthesizeCalls(fetchMock)).toHaveLength(2);
    expect(String(third)).toContain("500");
    expect(String(third)).not.toMatch(/already retried/);
  });

  it("keeps a hard fault out of the cold path", async () => {
    const fetchMock = setup();
    fetchMock.mockImplementation(async (url) => {
      if (endpointOf(String(url)) === "ready") return readyResponse();
      return new Response("boom", { status: 500 });
    });
    const err = await synthesizeModalClone(input).catch((e: unknown) => e);
    // A 500 is not a placement miss: the cold clock and its backoff must not
    // start, or the book would wait out a restore that is never coming.
    expect(err).not.toBeInstanceOf(ModalCloneColdError);
  });

  it("still treats a 503 as cold, so a restoring container parks the book", async () => {
    const fetchMock = setup();
    vi.stubEnv("MODAL_S2_READY", "0");
    fetchMock.mockImplementation(async () => new Response("warming", { status: 503 }));
    await expect(synthesizeModalClone(input)).rejects.toBeInstanceOf(
      ModalCloneColdError
    );
  });

  it("reports unusable audio as a provider fault, not a retry loop", async () => {
    const fetchMock = setup();
    fetchMock.mockImplementation(async (url) => {
      if (endpointOf(String(url)) === "ready") return readyResponse();
      return new Response(new Uint8Array([0, 1, 2, 3]), {
        headers: { "x-s2-duration": "12" },
      });
    });
    const err = await synthesizeModalClone(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModalCloneProviderError);
    expect(String(err)).toContain("invalid MP3");
  });
});
