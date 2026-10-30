import { afterEach, describe, expect, it, vi } from "vitest";
import { openFishTtsStream } from "./fish";
import {
  resetModalCloneRuntimeForTests,
  synthesizeModalClone,
  usesModalClone,
} from "./modal-clone";
import { blockModalCloneJob } from "./modal-clone-guard";
import { queryOne } from "@/lib/turso";
import { downloadFile } from "@/lib/storage";

vi.mock("@/lib/turso", () => ({ queryOne: vi.fn(), execute: vi.fn() }));
vi.mock("@/lib/storage", () => ({ downloadFile: vi.fn() }));

const input = {
  text: "It is a truth universally acknowledged.",
  voiceId: "private-fish-id",
  catalogVoiceId: "clone:saved-id",
  model: "s2.1-pro-free",
};
const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0, 1]); // "ID3"
const longText = "word ".repeat(200);

function readyResponse(status = 200, body: unknown = { ready: true }) {
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
  vi.stubEnv("MODAL_S2_TTS_URL", "https://example.modal.run/");
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
    if (String(url).endsWith("/ready")) return readyResponse();
    return mp3Response();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function synthesizeCalls(fetchMock: ReturnType<typeof setup>) {
  return fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/synthesize"));
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
    vi.stubEnv("MODAL_S2_TTS_URL", "https://example.modal.run");
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
    expect(String(call[0])).toBe("https://example.modal.run/synthesize");
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
      if (String(url).endsWith("/ready")) return readyResponse();
      return new Response(new Uint8Array([0, 1, 2, 3]));
    });
    await expect(synthesizeModalClone(input)).rejects.toThrow(/invalid MP3/);
  });

  it("surfaces the container's status and detail", async () => {
    const fetchMock = setup();
    fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith("/ready")) return readyResponse();
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

  it("skips synthesize when the probe says the container is cold", async () => {
    const fetchMock = setup();
    let readyCalls = 0;
    fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith("/ready")) {
        readyCalls += 1;
        return readyResponse(503, { ready: false, runners: 0 });
      }
      return mp3Response();
    });
    await expect(synthesizeModalClone(input)).rejects.toThrow(/not ready/);
    expect(synthesizeCalls(fetchMock)).toHaveLength(0);
    await expect(synthesizeModalClone(input)).rejects.toThrow(/not ready/);
    expect(readyCalls).toBe(1);
  });

  it("still synthesizes when the probe route is not deployed", async () => {
    const fetchMock = setup();
    fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith("/ready")) return new Response("nope", { status: 404 });
      return mp3Response();
    });
    await synthesizeModalClone(input);
    expect(synthesizeCalls(fetchMock)).toHaveLength(1);
  });

  it("skips the probe when MODAL_S2_READY=0", async () => {
    const fetchMock = setup();
    vi.stubEnv("MODAL_S2_READY", "0");
    await synthesizeModalClone(input);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).endsWith("/ready"))).toBe(
      false
    );
    expect(synthesizeCalls(fetchMock)).toHaveLength(1);
  });

  it("retries a truncated take once with a new seed", async () => {
    const fetchMock = setup();
    let synth = 0;
    fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith("/ready")) return readyResponse();
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
    expect(JSON.parse(String(calls[0]![1]!.body)).seed).toBeUndefined();
    expect(JSON.parse(String(calls[1]![1]!.body)).seed).toEqual(expect.any(Number));
  });

  it("does not call Modal when the daily cap is already spent", async () => {
    const fetchMock = setup();
    vi.stubEnv("MODAL_S2_USER_DAILY_CHARS", "1000");
    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (sql.includes("usage_logs")) return { user_chars: 1000, global_chars: 1000 };
      return {
        sample_storage_path: "clones/saved/sample.wav",
        reference_transcript: "the spoken text of the sample",
        user_id: "user_a",
      };
    });
    await expect(synthesizeModalClone(input)).rejects.toThrow(/cap/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fish adapter fallback order", () => {
  it("falls back to Drama 3 when the container times out", async () => {
    const fetchMock = setup();
    fetchMock.mockImplementation(async (url) => {
      const href = String(url);
      if (href.endsWith("/ready")) return readyResponse();
      if (href.endsWith("/synthesize")) throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      return mp3Response();
    });
    const res = await openFishTtsStream(input, "balanced");
    expect(synthesizeCalls(fetchMock)).toHaveLength(1);
    expect(String(fetchMock.mock.calls.at(-1)![0])).toContain("openrouter.ai/api/v1/audio/speech");
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
  });

  it("falls back after one truncated retry", async () => {
    const fetchMock = setup();
    fetchMock.mockImplementation(async (url) => {
      const href = String(url);
      if (href.endsWith("/ready")) return readyResponse();
      if (href.endsWith("/synthesize")) {
        return mp3Response({ "x-s2-duration": "2", "x-s2-truncated": "1" });
      }
      return mp3Response();
    });
    const res = await openFishTtsStream({ ...input, text: longText }, "balanced");
    expect(synthesizeCalls(fetchMock)).toHaveLength(2);
    expect(String(fetchMock.mock.calls.at(-1)![0])).toContain("openrouter.ai");
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
  });

  it("does not call Modal when MODAL_S2_TTS_URL is unset", async () => {
    const fetchMock = setup();
    vi.stubEnv("MODAL_S2_TTS_URL", "");
    vi.stubEnv("CLONE_TTS_PROVIDER", "");
    const res = await openFishTtsStream(input, "balanced");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("openrouter.ai");
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain("modal.run");
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
  });

  it("does not call Modal when the job is over the daily cap", async () => {
    const fetchMock = setup();
    blockModalCloneJob("job-1");
    const res = await openFishTtsStream({ ...input, jobId: "job-1" }, "balanced");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("openrouter.ai");
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
  });
});
