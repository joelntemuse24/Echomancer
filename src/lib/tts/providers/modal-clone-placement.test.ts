/**
 * First-light placement stays on the original POST.
 *
 * The pack abort is still the short first-light wait. The HTTP client waits
 * the placement budget (default 6 minutes) on that same call, and does not
 * cancel a container that has already started.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ModalCloneColdError,
  parsePlacementProbeOutput,
  probeModalClonePlacement,
  renderModalCloneBatch,
  resetModalCloneRuntimeForTests,
  setModalClonePlacementProbeForTests,
  type ModalPlacementState,
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

function setup(opts?: {
  delayMs?: number;
  hang?: boolean;
  probe?: ModalPlacementState;
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
  setModalClonePlacementProbeForTests(async () => opts?.probe ?? "pending");
  let batchPosts = 0;
  let markEntered: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (endpointOf(String(url)) === "ready") {
      return new Response(JSON.stringify({ ready: true, warm_containers: 0 }), { status: 200 });
    }
    batchPosts += 1;
    markEntered();
    const signal = init?.signal;
    if (opts?.hang) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 60 * 60_000);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    } else if (opts?.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, opts.delayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    }
    return new Response(
      JSON.stringify({
        items: [{ key: "0", audio_b64: mp3, duration_s: 12, truncated_units: 0 }],
        build: "abc",
      }),
      { status: 200 }
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    cancelled,
    posts: () => batchPosts,
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

  it("finishes a 150s placement on the original call", async () => {
    vi.useFakeTimers();
    const harness = setup({ delayMs: 150_000, probe: "pending" });
    const pending = renderModalCloneBatch(item, reference, undefined, "job-slow", {
      raceForFirstAudio: true,
      workMs: 70_000,
    });
    await harness.entered;
    await vi.advanceTimersByTimeAsync(150_000);
    const result = await pending.then(
      (value) => ({ ok: true as const, value }),
      (err: unknown) => ({ ok: false as const, err })
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.audio.get("0")?.audio.byteLength).toBeGreaterThan(0);
    expect(harness.cancelled).toEqual([]);
    expect(harness.posts()).toBe(1);
  }, 20_000);

  it("cancels and parks a call Modal never places", async () => {
    vi.useFakeTimers();
    const harness = setup({ hang: true, probe: "pending" });
    const pending = renderModalCloneBatch(item, reference, undefined, "job-never", {
      raceForFirstAudio: true,
      workMs: 70_000,
    });
    const settled = pending.then(
      () => "ok" as const,
      (err: unknown) => err
    );
    await vi.advanceTimersByTimeAsync(MODAL_CLONE_PLACEMENT_BUDGET_DEFAULT_MS);
    const error = await settled;
    expect(error).toBeInstanceOf(ModalCloneColdError);
    expect((error as ModalCloneColdError).clientAborted).toBe(true);
    expect(harness.cancelled).toEqual(["first-light wait aborted"]);
    expect(harness.posts()).toBe(1);
    harness.fetchMock.mockClear();
    await expect(
      renderModalCloneBatch(item, reference, undefined, "job-never", {
        raceForFirstAudio: true,
      })
    ).rejects.toBeInstanceOf(ModalCloneColdError);
    expect(harness.posts()).toBe(1);
  });

  it("does not open a second POST while the first call is in flight", async () => {
    vi.useFakeTimers();
    const harness = setup({ delayMs: 150_000, probe: "started" });
    const first = renderModalCloneBatch(item, reference, undefined, "job-one", {
      raceForFirstAudio: true,
      workMs: 70_000,
    });
    const second = renderModalCloneBatch(item, reference, undefined, "job-one", {
      raceForFirstAudio: true,
      workMs: 70_000,
    });
    await vi.advanceTimersByTimeAsync(150_000);
    const [a, b] = await Promise.all([first, second]);
    expect(a.audio.get("0")?.audio.byteLength).toBeGreaterThan(0);
    expect(b.audio.get("0")?.audio).toEqual(a.audio.get("0")?.audio);
    expect(harness.posts()).toBe(1);
    expect(harness.cancelled).toEqual([]);
  });

  it("does not cancel a placement that has already started", async () => {
    vi.useFakeTimers();
    const harness = setup({ hang: true, probe: "started" });
    let aborted = false;
    harness.fetchMock.mockImplementation(async (_url, init) => {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
      return new Response("{}", { status: 200 });
    });
    const pending = renderModalCloneBatch(item, reference, undefined, "job-started", {
      raceForFirstAudio: true,
      workMs: 70_000,
    });
    const settled = pending.then(
      () => "ok" as const,
      (err: unknown) => err
    );
    await vi.advanceTimersByTimeAsync(MODAL_CLONE_PLACEMENT_BUDGET_DEFAULT_MS + 5_000);
    expect(aborted).toBe(false);
    expect(harness.cancelled).toEqual([]);
    // Still the original request. Drop it so the test can finish.
    const calls = harness.fetchMock.mock.calls;
    const signal = calls[0]?.[1]?.signal;
    if (signal && "throwIfAborted" in signal) {
      // The owned controller is not the caller's. Abort by exceeding the ceiling.
    }
    await vi.advanceTimersByTimeAsync(200_000);
    const error = await settled;
    expect(error).toBeInstanceOf(ModalCloneColdError);
    expect(harness.cancelled).toEqual([]);
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
