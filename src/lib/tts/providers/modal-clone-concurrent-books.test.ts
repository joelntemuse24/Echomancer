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

    harness.setBatchMode("ok");
    harness.fetchMock.mockClear();
    noteModalClonePoolAnswered(Date.now(), "job-a");
    await renderModalCloneBatch([{ key: "0", text: "Hi." }], ref, undefined, "job-a", {
      warmBatch: true,
    });
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
