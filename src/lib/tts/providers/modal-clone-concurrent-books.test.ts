/**
 * Two clone books that start seconds apart on one Modal app.
 *
 * The deployed class is `@modal.concurrent(max_inputs=1)`. A warm container
 * that is already rendering book A does not take book B's POST; Modal places
 * B on another container, and that container still has to restore (30–81s,
 * or much longer when the host has no snapshot). Treating `warm_containers > 0`
 * as "this call is warm" arms the steady budget (~60s) and aborts that restore.
 * A steady miss used to freeze every book in the process for 30s.
 *
 * These tests do not call Modal. They pin the worker's clocks.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ModalCloneColdError,
  ModalCloneProviderError,
  loadCloneReference,
  modalCloneBookContainerWarm,
  modalCloneKnownWarmForCall,
  noteModalClonePoolAnswered,
  renderModalCloneBatch,
  resetModalCloneRuntimeForTests,
} from "./modal-clone";
import {
  MODAL_CLONE_COLD_WAIT_DEFAULT_MS,
  MODAL_CLONE_FIRST_LIGHT_WAIT_DEFAULT_MS,
  MODAL_CLONE_WARM_WAIT_DEFAULT_MS,
} from "./modal-clone-guard";
import { dispatchModalCloneLanes } from "./modal-clone-dispatch";
import {
  MODAL_CLONE_PREWARM_COOLDOWN_MS,
  prewarmModalCloneSnapshot,
  resetModalCloneWarmForTests,
  setModalCloneWarmSpawnerForTests,
} from "./modal-clone-warm";
import { downloadFile } from "@/lib/storage";
import { query, queryOne } from "@/lib/turso";
import { endpointOf, stubModalEndpoints } from "./modal-endpoints.fixture";
import { modalCloneMaxGpus } from "./modal-gpu-lease";

vi.mock("@/lib/turso", () => ({
  queryOne: vi.fn(),
  query: vi.fn(async () => []),
  execute: vi.fn(async () => ({ rowsAffected: 1 })),
}));
vi.mock("@/lib/storage", () => ({ downloadFile: vi.fn() }));

const mp3 = Buffer.from([0x49, 0x44, 0x33, 0, 1]).toString("base64");

type LeaseRow = { job_id: string; user_id: string; created_at: number };

function lease(jobId: string, userId = "user-a"): LeaseRow {
  return { job_id: jobId, user_id: userId, created_at: 1 };
}

function setup(opts?: { warmContainers?: number; leases?: LeaseRow[] }) {
  stubModalEndpoints(vi.stubEnv);
  vi.stubEnv("MODAL_S2_TOKEN", "test-token");
  vi.stubEnv("MODAL_S2_COLD_WAIT_MS", "");
  vi.stubEnv("MODAL_S2_FIRST_LIGHT_WAIT_MS", "");
  vi.stubEnv("MODAL_S2_TIMEOUT_MS", "");
  const warmContainers = opts?.warmContainers ?? 1;
  const leases = opts?.leases ?? [];
  vi.mocked(query).mockImplementation(async (sql: string) => {
    if (String(sql).includes("modal_gpu_leases")) return leases;
    return [];
  });
  vi.mocked(queryOne).mockResolvedValue({
    sample_storage_path: "clones/saved/sample.wav",
    reference_transcript: "the sample words",
    user_id: "user-a",
  });
  vi.mocked(downloadFile).mockResolvedValue(Buffer.from("reference audio"));
  let batchMode: "ok" | "timeout" = "ok";
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (endpointOf(String(url)) === "ready") {
      return new Response(
        JSON.stringify({ ready: true, warm_containers: warmContainers, build: "abc" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (batchMode === "timeout") {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    }
    return new Response(
      JSON.stringify({
        items: [{ key: "0", audio_b64: mp3, duration_s: 12, truncated_units: 0 }],
        build: "abc",
        container_id: "container-a",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    setBatchMode(mode: "ok" | "timeout") {
      batchMode = mode;
    },
    batchCalls() {
      return fetchMock.mock.calls.filter((call) => endpointOf(String(call[0])) === "batch");
    },
  };
}

function timeoutsOf(spy: { mock: { calls: unknown[][] } }): number[] {
  return spy.mock.calls.map((call) => Number(call[0]));
}

afterEach(() => {
  resetModalCloneRuntimeForTests();
  resetModalCloneWarmForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("spare warmth while another book occupies the only container", () => {
  it("arms the restore budget for a book that does not own a warm container", async () => {
    const { fetchMock } = setup({
      warmContainers: 1,
      leases: [lease("job-a")],
    });
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const ref = await loadCloneReference("clone:saved-id", "fish-id");
    // The mock answers 200. The assertion is the clock armed before the
    // body is read: a first call must not be the 60s steady budget.
    await renderModalCloneBatch([{ key: "0", text: "Hi." }], ref, undefined, "job-b", {
      raceForFirstAudio: true,
      workMs: 0,
    });
    const waits = timeoutsOf(timeout);
    expect(waits).toContain(MODAL_CLONE_FIRST_LIGHT_WAIT_DEFAULT_MS);
    expect(waits).not.toContain(60_000);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("keeps the 150s restore budget when the call is not first audio", async () => {
    setup({ warmContainers: 1, leases: [lease("job-a")] });
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const ref = await loadCloneReference("clone:saved-id", "fish-id");
    await renderModalCloneBatch([{ key: "0", text: "Hi." }], ref, undefined, "job-b", {
      workMs: 0,
    });
    const waits = timeoutsOf(timeout);
    expect(waits).toContain(MODAL_CLONE_COLD_WAIT_DEFAULT_MS);
    expect(waits).not.toContain(60_000);
  });
});

describe("one book's miss does not stall another book's ramp", () => {
  it("lets A post again after B's steady-budget miss", async () => {
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const harness = setup({ warmContainers: 2, leases: [] });
    const ref = await loadCloneReference("clone:saved-id", "fish-id");
    await renderModalCloneBatch([{ key: "0", text: "Hi." }], ref, undefined, "job-b");

    // B's own container has answered and nothing else is in flight, so this
    // call is the steady budget. Timing it out must not freeze A.
    harness.setBatchMode("timeout");
    const missed = await renderModalCloneBatch(
      [{ key: "1", text: "Hi again." }],
      ref,
      undefined,
      "job-b"
    ).then(
      () => {
        throw new Error("expected B to miss");
      },
      (err: unknown) => err
    );
    expect(missed).toBeInstanceOf(ModalCloneColdError);
    expect((missed as ModalCloneColdError).clientAborted).toBe(true);

    const held = harness.batchCalls().length;
    const again = await renderModalCloneBatch(
      [{ key: "2", text: "Still B." }],
      ref,
      undefined,
      "job-b"
    ).then(
      () => {
        throw new Error("expected B to stay in backoff");
      },
      (err: unknown) => err
    );
    expect(again).toBeInstanceOf(ModalCloneColdError);
    expect((again as ModalCloneColdError).selfBackoff).toBe(true);
    expect(harness.batchCalls().length).toBe(held);

    // A has not heard its own container. An app-wide clock would stop this
    // fetch. A's call has to reach Modal.
    harness.setBatchMode("ok");
    harness.fetchMock.mockClear();
    await renderModalCloneBatch([{ key: "0", text: "Hi." }], ref, undefined, "job-a");
    expect(harness.batchCalls().length).toBeGreaterThan(0);

    now += 30_000;
    harness.setBatchMode("ok");
    harness.fetchMock.mockClear();
    await renderModalCloneBatch([{ key: "3", text: "B again." }], ref, undefined, "job-b");
    expect(harness.batchCalls().length).toBeGreaterThan(0);
  });
});

describe("prewarm is per book and still inside the GPU cap", () => {
  function spawner() {
    const calls: string[][] = [];
    setModalCloneWarmSpawnerForTests((command, args) => {
      calls.push([command, ...args]);
    });
    return calls;
  }

  it("starts a restore for book B even when book A just prewarmed", () => {
    vi.stubEnv("MODAL_TOKEN_ID", "test-token");
    const calls = spawner();
    expect(
      prewarmModalCloneSnapshot("book A is starting", 1_000, { jobId: "job-a" })
    ).toBe(true);
    expect(
      prewarmModalCloneSnapshot("book B is starting", 2_000, { jobId: "job-b" })
    ).toBe(true);
    expect(calls).toHaveLength(2);
    expect(
      prewarmModalCloneSnapshot("book A again", 3_000, { jobId: "job-a" })
    ).toBe(false);
    expect(
      prewarmModalCloneSnapshot(
        "book A after cooldown",
        1_000 + MODAL_CLONE_PREWARM_COOLDOWN_MS,
        { jobId: "job-a" }
      )
    ).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it("does not start a restore once the shared GPU cap is full", () => {
    vi.stubEnv("MODAL_TOKEN_ID", "test-token");
    const calls = spawner();
    const cap = modalCloneMaxGpus();
    const leases = Array.from({ length: cap }, (_, index) => ({
      jobId: `held-${index}`,
      userId: `user-${index}`,
    }));
    expect(
      prewarmModalCloneSnapshot("book B is starting", 1_000, {
        jobId: "job-b",
        userId: "user-b",
        leases,
      })
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("does not start a restore once this user is at their GPU cap", () => {
    vi.stubEnv("MODAL_TOKEN_ID", "test-token");
    vi.stubEnv("MODAL_S2_MAX_GPUS_PER_USER", "1");
    const calls = spawner();
    expect(
      prewarmModalCloneSnapshot("book B is starting", 1_000, {
        jobId: "job-b",
        userId: "user-b",
        leases: [{ jobId: "job-a", userId: "user-b" }],
      })
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("still prewarms when the only lease is this book's own row", () => {
    vi.stubEnv("MODAL_TOKEN_ID", "test-token");
    vi.stubEnv("MODAL_S2_MAX_GPUS", "1");
    const calls = spawner();
    expect(
      prewarmModalCloneSnapshot("book B is starting", 1_000, {
        jobId: "job-b",
        userId: "user-b",
        leases: [{ jobId: "job-b", userId: "user-b" }],
      })
    ).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("counts restores already started, even with an empty lease table", () => {
    vi.stubEnv("MODAL_TOKEN_ID", "test-token");
    vi.stubEnv("MODAL_S2_MAX_GPUS", "2");
    const calls = spawner();
    expect(
      prewarmModalCloneSnapshot("book A", 1_000, {
        jobId: "job-a",
        leases: [],
      })
    ).toBe(true);
    expect(
      prewarmModalCloneSnapshot("book B", 1_000, {
        jobId: "job-b",
        leases: [],
      })
    ).toBe(true);
    expect(
      prewarmModalCloneSnapshot("book C", 1_000, {
        jobId: "job-c",
        leases: [],
      })
    ).toBe(false);
    expect(calls).toHaveLength(2);
  });
});

describe("a client abort does not post the same sections again", () => {
  it("does not re-dispatch a book wave after the worker drops the HTTP wait", async () => {
    const render = vi.fn(async () => {
      const error = new ModalCloneColdError(
        "Modal clone did not answer within 75s",
        30_000,
        "placement",
        "restore",
        true
      );
      throw error;
    });
    const result = await dispatchModalCloneLanes({
      indexes: [0, 1, 2, 3],
      textAt: () => "x".repeat(1_000),
      lanes: 4,
      batch: 24,
      maxLaneChars: 8_000,
      seedEpoch: 0,
      firstLight: true,
      bookWave: true,
      poolWarm: false,
      jobId: "job-b",
      render,
      stage: async () => {},
    });
    expect(render).toHaveBeenCalledTimes(1);
    expect(result.cold).toBe(true);
    expect(result.staged).toBe(0);
    // The sync Modal handler keeps rendering after the worker drops the
    // HTTP wait. A second POST of these sections would start another
    // container (`max_inputs=1` does not return 429) and bill the same
    // text twice. The next attempt waits on this book's backoff.
  });
});

describe("warmth is spare containers plus this book's own answer", () => {
  it("does not call a busy pool warm for a book that has not heard its container", () => {
    expect(
      modalCloneKnownWarmForCall({
        warmContainers: 1,
        inflightCalls: 1,
        bookContainerWarm: false,
        jobScoped: true,
      })
    ).toBe(false);
    expect(
      modalCloneKnownWarmForCall({
        warmContainers: 2,
        inflightCalls: 0,
        bookContainerWarm: false,
        jobScoped: true,
      })
    ).toBe(false);
    expect(
      modalCloneKnownWarmForCall({
        warmContainers: 2,
        inflightCalls: 1,
        bookContainerWarm: true,
        jobScoped: true,
      })
    ).toBe(true);
    expect(
      modalCloneKnownWarmForCall({
        warmContainers: -1,
        inflightCalls: 0,
        bookContainerWarm: false,
        jobScoped: true,
      })
    ).toBe(false);
    expect(
      modalCloneKnownWarmForCall({
        warmContainers: -1,
        inflightCalls: 0,
        bookContainerWarm: true,
        jobScoped: true,
      })
    ).toBe(true);
  });

  it("records warmth on the book that answered", () => {
    const now = Date.now();
    noteModalClonePoolAnswered(now, "job-a");
    expect(modalCloneBookContainerWarm("job-a", now)).toBe(true);
    expect(modalCloneBookContainerWarm("job-b", now)).toBe(false);
  });
});

describe("a busy pool is not a warm ramp", () => {
  it("gives a confirmed book the restore budget when the warm container is leased", async () => {
    const harness = setup({
      warmContainers: 1,
      leases: [lease("job-b", "user-b")],
    });
    const waits: number[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      waits.push(ms);
      return new AbortController().signal;
    });
    noteModalClonePoolAnswered(Date.now(), "job-a");
    const ref = await loadCloneReference("clone:saved-id", "fish-id");
    await renderModalCloneBatch([{ key: "0", text: "Hi." }], ref, undefined, "job-a", {
      warmBatch: true,
    });
    expect(harness.batchCalls().length).toBeGreaterThan(0);
    expect(waits).not.toContain(MODAL_CLONE_WARM_WAIT_DEFAULT_MS);
    expect(waits).toContain(MODAL_CLONE_COLD_WAIT_DEFAULT_MS);
  });

  it("plans a cold call when the spare container is already leased", async () => {
    setup({
      warmContainers: 1,
      leases: [lease("job-b", "user-b")],
    });
    noteModalClonePoolAnswered(Date.now(), "job-a");
    const seen: { count: number; warmBatch?: boolean }[] = [];
    const render = vi.fn(async (items: { key: string }[], _ref: unknown, opts?: { warmBatch?: boolean }) => {
      seen.push({ count: items.length, warmBatch: opts?.warmBatch });
      throw new Error("stop after the plan");
    });
    await dispatchModalCloneLanes({
      indexes: Array.from({ length: 24 }, (_, index) => index),
      textAt: () => "x".repeat(2_000),
      lanes: 1,
      batch: 24,
      maxLaneChars: 48_000,
      seedEpoch: 0,
      jobId: "job-a",
      bookWave: true,
      playbackStarted: true,
      bufferedMs: 600_000,
      render,
      stage: async () => {},
    });
    expect(seen[0]?.warmBatch).toBe(false);
    expect(seen[0]?.count).toBeLessThan(24);
  });
});

describe("a later ramp call is not posted again after a timeout", () => {
  it("stops the wave on the aborted call", async () => {
    const render = vi.fn(async () => {
      throw new ModalCloneColdError(
        "Modal clone did not answer within 400s",
        30_000,
        "placement",
        "warm",
        true
      );
    });
    const result = await dispatchModalCloneLanes({
      indexes: [0, 1, 2, 3, 4, 5],
      textAt: () => "x".repeat(2_000),
      lanes: 1,
      batch: 24,
      maxLaneChars: 48_000,
      seedEpoch: 0,
      jobId: "job-a",
      bookWave: true,
      poolWarm: true,
      playbackStarted: true,
      bufferedMs: 600_000,
      render,
      stage: async () => {},
    });
    expect(render).toHaveBeenCalledTimes(1);
    expect(result.abortedIndexes.length).toBeGreaterThan(1);
    expect(result.staged).toBe(0);
  });

  it("retries a gateway miss once and does not retry a timeout", async () => {
    const gateway = vi.fn(async () => {
      throw new ModalCloneColdError("502", 30_000, "placement", "restore", false);
    });
    await dispatchModalCloneLanes({
      indexes: [0, 1, 2],
      textAt: () => "x".repeat(1_000),
      lanes: 1,
      batch: 24,
      seedEpoch: 0,
      jobId: "job-b",
      bookWave: true,
      firstLight: true,
      poolWarm: false,
      render: gateway,
      stage: async () => {},
    });
    expect(gateway).toHaveBeenCalledTimes(2);

    const timeout = vi.fn(async () => {
      throw new ModalCloneColdError(
        "did not answer",
        30_000,
        "placement",
        "restore",
        true
      );
    });
    await dispatchModalCloneLanes({
      indexes: [0, 1, 2],
      textAt: () => "x".repeat(1_000),
      lanes: 1,
      batch: 24,
      seedEpoch: 0,
      jobId: "job-c",
      bookWave: true,
      firstLight: true,
      poolWarm: false,
      render: timeout,
      stage: async () => {},
    });
    expect(timeout).toHaveBeenCalledTimes(1);
  });

  it("forgets this book's container after a provider 500", async () => {
    noteModalClonePoolAnswered(Date.now(), "job-a");
    expect(modalCloneBookContainerWarm("job-a")).toBe(true);
    const render = vi.fn(async () => {
      throw new ModalCloneProviderError("Modal clone TTS 500: boom");
    });
    await dispatchModalCloneLanes({
      indexes: [0, 1, 2],
      textAt: () => "x".repeat(2_000),
      lanes: 1,
      batch: 24,
      seedEpoch: 0,
      jobId: "job-a",
      bookWave: true,
      poolWarm: true,
      playbackStarted: true,
      bufferedMs: 600_000,
      render,
      stage: async () => {},
    });
    expect(modalCloneBookContainerWarm("job-a")).toBe(false);
  });
});
