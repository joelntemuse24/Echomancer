/**
 * First light submits, stores the function-call id, then polls that id.
 *
 * The accept itself is short. Once the id is stored, the poll runs to the
 * proxy ceiling and Stop is the thing that cancels it. A submit that never
 * returns an id does not call the CLI cancel and does not start a second GPU.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ModalCloneColdError,
  parsePlacementProbeOutput,
  probeModalClonePlacement,
  renderModalCloneBatch,
  resetModalCloneRuntimeForTests,
  setModalClonePlacementProbeForTests,
} from "./modal-clone";
import { setModalCloneCallCancellerForTests } from "./modal-clone-cancel";
import { setModalCloneWarmSpawnerForTests } from "./modal-clone-warm";
import { MODAL_CLONE_PLACEMENT_BUDGET_DEFAULT_MS } from "./modal-clone-guard";
import { endpointOf, stubModalEndpoints } from "./modal-endpoints.fixture";
import { execute, queryOne } from "@/lib/turso";

vi.mock("@/lib/turso", () => ({
  queryOne: vi.fn(),
  query: vi.fn(async () => []),
  execute: vi.fn(async () => ({ rowsAffected: 1 })),
}));

const mp3 = Buffer.from([0x49, 0x44, 0x33, 0, 1]).toString("base64");
const reference = {
  audio: Buffer.from("reference audio"),
  transcript: "the sample words",
  userId: "user-a",
  catalogVoiceId: "clone:saved",
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function setup(opts?: {
  /** Status stays pending until this much fake time has passed, then the audio arrives. */
  pendingForMs?: number;
  /** The accept never returns an id. */
  hangSubmit?: boolean;
  /** The id is stored and every status stays pending. */
  hangStatus?: boolean;
}) {
  stubModalEndpoints(vi.stubEnv);
  vi.stubEnv("MODAL_S2_TOKEN", "test-token");
  vi.stubEnv("MODAL_S2_READY", "0");
  vi.mocked(queryOne).mockResolvedValue(null);
  vi.mocked(execute).mockResolvedValue({ rowsAffected: 1 } as never);
  const cancelled: string[] = [];
  setModalCloneCallCancellerForTests((reason) => {
    cancelled.push(reason.reason ?? "");
    return true;
  });
  setModalCloneWarmSpawnerForTests(() => undefined);
  setModalClonePlacementProbeForTests(async () => "pending");
  let submits = 0;
  let acceptedAt = 0;
  let markEntered: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (endpointOf(String(url)) === "ready") {
      return jsonResponse({ ready: true, warm_containers: 0 });
    }
    const payload = JSON.parse(String(init?.body ?? "{}")) as {
      items?: unknown;
      call_id?: string;
    };
    const signal = init?.signal;
    if (payload.items) {
      submits += 1;
      markEntered();
      acceptedAt = Date.now();
      if (opts?.hangSubmit) {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
      }
      return jsonResponse({ call_id: "fc-place", status: "pending" });
    }
    if (opts?.hangStatus || (opts?.pendingForMs && Date.now() - acceptedAt < opts.pendingForMs)) {
      return jsonResponse({ call_id: payload.call_id, status: "pending" });
    }
    return jsonResponse({
      call_id: payload.call_id ?? "fc-place",
      status: "success",
      result: {
        items: [{ key: "0", audio_b64: mp3, duration_s: 12, truncated_units: 0 }],
        build: "abc",
      },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    cancelled,
    posts: () => submits,
    entered,
  };
}

const item = [{ key: "0", text: "Section zero of the book." }];

afterEach(() => {
  resetModalCloneRuntimeForTests();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("first-light placement budget", () => {
  it("keeps the default at 6 minutes under the proxy kill", () => {
    expect(MODAL_CLONE_PLACEMENT_BUDGET_DEFAULT_MS).toBe(360_000);
  });

  it("finishes a 150s placement on the spawned call", async () => {
    vi.useFakeTimers();
    const harness = setup({ pendingForMs: 150_000 });
    const pending = renderModalCloneBatch(item, reference, undefined, "job-slow", {
      raceForFirstAudio: true,
      workMs: 70_000,
    });
    await harness.entered;
    await vi.advanceTimersByTimeAsync(152_000);
    const result = await pending.then(
      (value) => ({ ok: true as const, value }),
      (err: unknown) => ({ ok: false as const, err })
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.audio.get("0")?.audio.byteLength).toBeGreaterThan(0);
    expect(harness.cancelled).toEqual([]);
    expect(harness.posts()).toBe(1);
  }, 20_000);

  it("parks a submit that never returns an id and does not start a second GPU", async () => {
    vi.useFakeTimers();
    const harness = setup({ hangSubmit: true });
    const pending = renderModalCloneBatch(item, reference, undefined, "job-never", {
      raceForFirstAudio: true,
      workMs: 70_000,
    });
    const settled = pending.then(
      () => "ok" as const,
      (err: unknown) => err
    );
    await harness.entered;
    await vi.advanceTimersByTimeAsync(MODAL_CLONE_PLACEMENT_BUDGET_DEFAULT_MS);
    const error = await settled;
    expect(error).toBeInstanceOf(ModalCloneColdError);
    expect((error as ModalCloneColdError).clientAborted).toBe(true);
    expect(harness.cancelled).toEqual([]);
    expect(harness.posts()).toBe(1);
    await expect(
      renderModalCloneBatch(item, reference, undefined, "job-never", {
        raceForFirstAudio: true,
      })
    ).rejects.toMatchObject({ name: "ModalCloneHeldError", reason: "sealed" });
    expect(harness.posts()).toBe(1);
  });

  it("does not open a second submit while the first call is in flight", async () => {
    vi.useFakeTimers();
    const harness = setup({ pendingForMs: 150_000 });
    const first = renderModalCloneBatch(item, reference, undefined, "job-one", {
      raceForFirstAudio: true,
      workMs: 70_000,
    });
    const second = renderModalCloneBatch(item, reference, undefined, "job-one", {
      raceForFirstAudio: true,
      workMs: 70_000,
    });
    await harness.entered;
    await vi.advanceTimersByTimeAsync(152_000);
    const [a, b] = await Promise.all([first, second]);
    expect(a.audio.get("0")?.audio.byteLength).toBeGreaterThan(0);
    expect(b.audio.get("0")?.audio).toEqual(a.audio.get("0")?.audio);
    expect(harness.posts()).toBe(1);
    expect(harness.cancelled).toEqual([]);
  });

  it("does not cancel a spawned call when the placement budget passes", async () => {
    vi.useFakeTimers();
    const harness = setup({ hangStatus: true });
    let statusAborted = false;
    const pending = renderModalCloneBatch(item, reference, undefined, "job-started", {
      raceForFirstAudio: true,
      workMs: 70_000,
    });
    const settled = pending.then(
      () => "ok" as const,
      (err: unknown) => err
    );
    await harness.entered;
    const original = harness.fetchMock.getMockImplementation();
    harness.fetchMock.mockImplementation(async (url, init) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { call_id?: string; items?: unknown };
      if (payload.call_id && !payload.items) {
        init?.signal?.addEventListener("abort", () => {
          statusAborted = true;
        });
      }
      return original?.(url, init) as Promise<Response>;
    });
    await vi.advanceTimersByTimeAsync(MODAL_CLONE_PLACEMENT_BUDGET_DEFAULT_MS + 5_000);
    expect(statusAborted).toBe(false);
    expect(harness.cancelled).toEqual([]);
    await vi.advanceTimersByTimeAsync(200_000);
    const error = await settled;
    expect(error).toBeInstanceOf(ModalCloneColdError);
    expect(harness.cancelled).toEqual([]);
    expect(harness.posts()).toBe(1);
  });
});

describe("placement probe output", () => {
  it("reads the script's last word and ignores anything else", () => {
    expect(parsePlacementProbeOutput("started\n")).toBe("started");
    expect(parsePlacementProbeOutput("log line\npending")).toBe("pending");
    expect(parsePlacementProbeOutput("gone")).toBe("gone");
    expect(parsePlacementProbeOutput("")).toBe("unknown");
    expect(parsePlacementProbeOutput("compiling")).toBe("unknown");
  });

  it("does not spawn Modal from a unit test", async () => {
    await expect(probeModalClonePlacement("job-1")).resolves.toBe("unknown");
  });
});
