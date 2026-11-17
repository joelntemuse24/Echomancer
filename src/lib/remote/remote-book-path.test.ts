import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TakehomeWorkerLoop } from "@/worker/takehome-loop";
import { routeTakehomeWorkerRequest } from "@/worker/takehome-http";
import { resetDatabase } from "@/test/harness";
import {
  admitRemoteCall,
  bookSpend,
  mergedIntervalMs,
  planDrain,
  remoteEvents,
  remoteFlights,
  replacePersistedSpend,
  resetRemoteLayerForTests,
  runRemoteCall,
  interpretCancelResult,
} from "@/lib/remote/layer";
import { drainBookCalls, setDrainHooksForTests } from "@/lib/remote/drain-book";
import { prewarmS2Clone, setPrewarmSpawnForTests } from "@/lib/remote/prewarm";
import {
  reconcileRemoteCalls,
  setBrakeHealerForTests,
  setBrakeMaxReaderForTests,
} from "@/lib/remote/reconcile";
import { cancelS2Call, setS2StatusBudgetForTests } from "@/lib/tts/providers/modal-clone-call";
import {
  hydrateOpenRemoteCalls,
  loadActiveBrakes,
  persistRemoteEvent,
  saveActiveBrake,
} from "@/lib/remote/store";
import {
  ModalCloneColdError,
  ModalCloneHeldError,
  renderModalCloneBatch,
  resetModalCloneRuntimeForTests,
} from "@/lib/tts/providers/modal-clone";
import { dispatchModalCloneLanes } from "@/lib/tts/providers/modal-clone-dispatch";
import { setModalCloneCallCancellerForTests } from "@/lib/tts/providers/modal-clone-cancel";
import {
  kickModalCloneSnapshotWarm,
  resetModalCloneWarmForTests,
  setModalCloneWarmSpawnerForTests,
} from "@/lib/tts/providers/modal-clone-warm";
import {
  endpointOf,
  readyBody,
  stubModalEndpoints,
} from "@/lib/tts/providers/modal-endpoints.fixture";

const reference = {
  audio: Buffer.from("reference-audio"),
  transcript: "a short spoken sample",
  userId: "user_a",
  catalogVoiceId: "clone:book",
};

afterEach(() => {
  resetRemoteLayerForTests();
  resetModalCloneRuntimeForTests();
  resetModalCloneWarmForTests();
  setDrainHooksForTests(null);
  setModalCloneWarmSpawnerForTests(null);
  setModalCloneCallCancellerForTests(null);
  setPrewarmSpawnForTests(null);
  setBrakeHealerForTests(null);
  setBrakeMaxReaderForTests(null);
  setS2StatusBudgetForTests(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("remote book path", () => {
  it("does not start a second GPU input while the first call is still live", async () => {
    await resetDatabase();
    stubModalEndpoints(vi.stubEnv);
    vi.stubEnv("MODAL_S2_TOKEN", "test-token");
    vi.stubEnv("MODAL_TOKEN_ID", "test-token");
    const kicks: string[] = [];
    setModalCloneWarmSpawnerForTests(() => {
      kicks.push("cover");
    });
    setModalCloneCallCancellerForTests(() => {});
    let batchPosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (endpointOf(String(url)) === "ready") {
          return new Response(JSON.stringify(readyBody()), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        batchPosts += 1;
        const err = new Error("timed out");
        err.name = "TimeoutError";
        throw err;
      })
    );

    await expect(
      renderModalCloneBatch(
        [{ key: "0", text: "The harbor was quiet." }],
        reference,
        undefined,
        "book-live"
      )
    ).rejects.toBeInstanceOf(ModalCloneColdError);
    const postsAfterFirst = batchPosts;
    const kicksAfterFirst = kicks.length;

    await expect(
      renderModalCloneBatch(
        [{ key: "0", text: "The harbor was quiet." }],
        reference,
        undefined,
        "book-live"
      )
    ).rejects.toBeInstanceOf(ModalCloneHeldError);
    expect(batchPosts).toBe(postsAfterFirst);
    expect(kicks.length).toBe(kicksAfterFirst);
  });

  it("treats a budget refusal as held, not a cold placement", async () => {
    vi.stubEnv("REMOTE_ENFORCE_BUDGETS", "1");
    vi.stubEnv("REMOTE_BOOK_BUDGET_USD", "0.001");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const kicks: string[] = [];
    setModalCloneWarmSpawnerForTests(() => {
      kicks.push("cover");
    });
    await expect(
      renderModalCloneBatch(
        [{ key: "0", text: "The harbor was quiet." }],
        reference,
        undefined,
        "book-budget"
      )
    ).rejects.toMatchObject({ name: "ModalCloneHeldError", reason: "budget" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(kicks).toEqual([]);
  });

  it("does not kick cover when dispatch is only held", async () => {
    const kicks: string[] = [];
    setModalCloneWarmSpawnerForTests(() => {
      kicks.push("cover");
    });
    vi.stubEnv("MODAL_TOKEN_ID", "test-token");
    const result = await dispatchModalCloneLanes({
      indexes: [0],
      textAt: () => "A short section.",
      lanes: 1,
      batch: 1,
      maxLaneChars: 8_000,
      seedEpoch: 0,
      jobId: "book-held",
      render: async () => {
        throw new ModalCloneHeldError("in_flight", "waiting");
      },
      stage: async () => {},
    });
    expect(result.held).toBe(true);
    expect(result.cold).toBe(false);
    expect(result.budgetStop).toBe(false);
    expect(result.abortedIndexes).toEqual([]);
    expect(kicks).toEqual([]);
  });

  it("cancels the stored call through POST /drain and does not brake while another book is live", async () => {
    const cancelled: string[] = [];
    let braked = false;
    let restored: number | null = null;
    setDrainHooksForTests({
      cancel: async (callId) => {
        cancelled.push(callId);
        return { status: "terminated" };
      },
      brake: async () => {
        braked = true;
      },
      runningContainers: async () => 0,
      restore: async (_app, max) => {
        restored = max;
      },
      readMax: async () => 20,
    });
    const stopped = admitRemoteCall({
      provider: "s2-clone",
      path: "book",
      jobId: "book-a",
      sections: ["0"],
      callId: "fc-a",
    });
    if (stopped.kind === "start") stopped.finish("still_live");
    const other = admitRemoteCall({
      provider: "s2-clone",
      path: "book",
      jobId: "book-b",
      sections: ["0"],
      callId: "fc-b",
    });
    expect(other.kind).toBe("start");

    process.env.WORKER_SECRET = "s3cret";
    const loop = new TakehomeWorkerLoop({
      concurrency: 1,
      budgetMs: 1000,
      runner: {
        runUntilSettled: vi.fn(async () => ({ status: "queued" })),
        listDrainable: vi.fn(async () => []),
        releaseExpired: vi.fn(async () => 0),
      },
      log: { info: () => {}, error: () => {} },
    });
    const result = await routeTakehomeWorkerRequest({
      method: "POST",
      url: "/drain",
      authorization: "Bearer s3cret",
      workerSecret: "s3cret",
      bodyText: JSON.stringify({ jobId: "book-a" }),
      loop,
      startedAt: Date.now(),
      drainBook: (jobId) => drainBookCalls(jobId, "cancelled"),
    });
    expect(result.status).toBe(202);
    expect(cancelled).toEqual(["fc-a"]);
    expect(braked).toBe(false);
    expect(restored).toBeNull();
    const live = remoteFlights().filter((flight) => flight.jobId === "book-b");
    expect(live.some((flight) => flight.status === "running")).toBe(true);
  });

  it("restores the max read before the brake, not 1", async () => {
    const order: string[] = [];
    setDrainHooksForTests({
      cancel: async () => {
        order.push("cancel");
        return { threw: "NotFound" };
      },
      brake: async () => {
        order.push("brake");
      },
      runningContainers: async () => {
        order.push("count");
        return 0;
      },
      restore: async (_app, max) => {
        order.push(`restore:${max}`);
      },
      readMax: async () => 20,
    });
    const flight = admitRemoteCall({
      provider: "s2-clone",
      path: "book",
      jobId: "book-only",
      sections: ["0"],
      callId: "fc-only",
    });
    if (flight.kind === "start") flight.finish("still_live");
    await drainBookCalls("book-only", "cancelled");
    expect(order).toEqual(["cancel", "brake", "count", "restore:20"]);
    const restore = planDrain(0).find((step) => step.step === "restore_autoscaler");
    expect(restore).toMatchObject({ maxContainers: 0, minContainers: 0 });
  });

  it("keeps the newest still_live after a restart", async () => {
    await resetDatabase();
    resetRemoteLayerForTests();
    const key = "s2-clone|book-h|0";
    const now = Date.now();
    await persistRemoteEvent({
      id: "older-failure",
      flightKey: key,
      idempotencyKey: key,
      provider: "s2-clone",
      path: "book",
      jobId: "book-h",
      section: "0",
      outcome: "failure",
      startedAt: now - 10_000,
      endedAt: now - 9_000,
    });
    await persistRemoteEvent({
      id: "newer-live",
      flightKey: key,
      idempotencyKey: key,
      provider: "s2-clone",
      path: "book",
      jobId: "book-h",
      section: "0",
      callId: "fc-live",
      outcome: "still_live",
      startedAt: now - 1_000,
    });
    resetRemoteLayerForTests();
    expect(await hydrateOpenRemoteCalls()).toBe(1);
    const flights = remoteFlights();
    expect(flights).toHaveLength(1);
    expect(flights[0]).toMatchObject({ status: "still_live", callId: "fc-live" });
  });

  it("keeps spent dollars across a restart and blocks the next call", async () => {
    await resetDatabase();
    resetRemoteLayerForTests();
    const now = Date.now();
    await persistRemoteEvent({
      id: "spent",
      flightKey: "s2-clone|book-spend|1",
      idempotencyKey: "s2-clone|book-spend|1",
      provider: "s2-clone",
      path: "book",
      jobId: "book-spend",
      section: "1",
      outcome: "started",
      estCostUsd: 19,
      startedAt: now - 5_000,
      endedAt: now - 1_000,
    });
    resetRemoteLayerForTests();
    await hydrateOpenRemoteCalls();
    expect(bookSpend("book-spend").usd).toBeCloseTo(19);
    const next = admitRemoteCall({
      provider: "s2-clone",
      path: "book",
      jobId: "book-spend",
      sections: ["2"],
      estCostUsd: 2,
      enforceBudget: true,
      caps: { bookUsd: 20, dailyUsd: 80, bookMs: 6 * 60 * 60_000, dailyMs: 12 * 60 * 60_000 },
    });
    expect(next.kind).toBe("blocked");
    if (next.kind === "blocked") expect(next.reason).toBe("budget");
  });

  it("counts overlapping Kokoro lanes as one wall clock", () => {
    replacePersistedSpend([
      { key: "lane-a", jobId: "kokoro-book", usd: 0.01, start: 1_000, end: 11_000 },
      { key: "lane-b", jobId: "kokoro-book", usd: 0.01, start: 2_000, end: 11_000 },
    ]);
    expect(mergedIntervalMs([[1_000, 11_000], [2_000, 11_000]])).toBe(10_000);
    expect(bookSpend("kokoro-book", 11_000).ms).toBe(10_000);
    expect(bookSpend("kokoro-book", 11_000).usd).toBeCloseTo(0.02);
  });

  it("lets an aborted HTTP call be retried and keeps a Modal abort still live", async () => {
    await expect(
      runRemoteCall({
        provider: "kokoro",
        path: "book",
        jobId: "kokoro-retry",
        sections: ["0"],
        abortSettlesAs: "failure",
        execute: async () => {
          throw new DOMException("The operation was aborted.", "AbortError");
        },
      })
    ).rejects.toThrow(/aborted/i);
    const again = admitRemoteCall({
      provider: "kokoro",
      path: "book",
      jobId: "kokoro-retry",
      sections: ["0"],
    });
    expect(again.kind).toBe("start");

    await expect(
      runRemoteCall({
        provider: "s2-clone",
        path: "book",
        jobId: "s2-retry",
        sections: ["0"],
        execute: async () => {
          throw new DOMException("The operation was aborted.", "AbortError");
        },
      })
    ).rejects.toThrow(/aborted/i);
    const blocked = admitRemoteCall({
      provider: "s2-clone",
      path: "book",
      jobId: "s2-retry",
      sections: ["0"],
    });
    expect(blocked.kind).toBe("blocked");
  });

  it("stores the spawned call id before the poll, and Stop cancels that id", async () => {
    await resetDatabase();
    stubModalEndpoints(vi.stubEnv);
    vi.stubEnv("MODAL_S2_TOKEN", "test-token");
    vi.stubEnv("MODAL_TOKEN_ID", "test-token");
    setS2StatusBudgetForTests(250);
    const kicks: string[] = [];
    setModalCloneWarmSpawnerForTests(() => {
      kicks.push("cover");
    });
    let idStoredBeforePoll = false;
    const httpCancels: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (endpointOf(String(url)) === "ready") {
          return new Response(JSON.stringify(readyBody()), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        const payload = JSON.parse(String(init?.body ?? "{}")) as {
          items?: unknown;
          call_id?: string;
          cancel?: boolean;
        };
        if (payload.cancel) {
          httpCancels.push(String(payload.call_id));
          return new Response(
            JSON.stringify({ call_id: payload.call_id, status: "cancelled" }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (payload.call_id && !payload.items) {
          const flight = remoteFlights().find((row) => row.jobId === "book-timeout");
          idStoredBeforePoll = flight?.callId === "fc-1";
          const err = new Error("status timed out");
          err.name = "TimeoutError";
          throw err;
        }
        return new Response(JSON.stringify({ call_id: "fc-1", status: "pending" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      })
    );
    await expect(
      renderModalCloneBatch(
        [{ key: "0", text: "The harbor was quiet." }],
        reference,
        undefined,
        "book-timeout"
      )
    ).rejects.toBeInstanceOf(ModalCloneColdError);
    expect(idStoredBeforePoll).toBe(true);
    expect(kicks).toEqual([]);
    expect(kickModalCloneSnapshotWarm("while the call was live", Date.now(), "other-book")).toBe(
      false
    );
    const live = remoteFlights().find((flight) => flight.jobId === "book-timeout");
    expect(live).toMatchObject({ status: "still_live", callId: "fc-1" });
    const still = remoteEvents().find((event) => event.outcome === "still_live");
    expect(still?.callId).toBe("fc-1");
    await persistRemoteEvent(still!);
    resetRemoteLayerForTests();
    expect(await hydrateOpenRemoteCalls()).toBe(1);
    expect(remoteFlights()[0]).toMatchObject({
      status: "still_live",
      callId: "fc-1",
    });

    setDrainHooksForTests({
      cancel: (callId) => cancelS2Call(callId),
      brake: async () => {
        throw new Error("must not brake a terminal cancel");
      },
      runningContainers: async () => 0,
      restore: async () => {},
      readMax: async () => 20,
    });
    await drainBookCalls("book-timeout", "cancelled");
    expect(httpCancels).toEqual(["fc-1"]);
    expect(remoteFlights().find((flight) => flight.callId === "fc-1")?.status).toBe(
      "cancelled"
    );
  });

  it("does not spawn cover while an S2 flight is running or still live", async () => {
    stubModalEndpoints(vi.stubEnv);
    vi.stubEnv("MODAL_S2_TOKEN", "test-token");
    vi.stubEnv("MODAL_TOKEN_ID", "test-token");
    const kicks: string[] = [];
    setModalCloneWarmSpawnerForTests(() => {
      kicks.push("cover");
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (endpointOf(String(url)) === "ready") {
          return new Response(JSON.stringify(readyBody({ warm_containers: 0, ready: true })), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        const err = new Error("timed out");
        err.name = "TimeoutError";
        throw err;
      })
    );
    await expect(
      renderModalCloneBatch(
        [{ key: "0", text: "The harbor was quiet." }],
        reference,
        undefined,
        "book-cover"
      )
    ).rejects.toBeInstanceOf(ModalCloneColdError);
    expect(kicks).toEqual([]);
    const live = remoteFlights().find((flight) => flight.jobId === "book-cover");
    expect(live).toMatchObject({ status: "still_live" });
    expect(live?.callId).toBeFalsy();
    expect(kickModalCloneSnapshotWarm("own book", Date.now(), "book-cover")).toBe(false);
    expect(kickModalCloneSnapshotWarm("other book", Date.now(), "book-other")).toBe(true);
  });

  it("restores the saved max when containers stay up and when the brake throws", async () => {
    const restored: number[] = [];
    setDrainHooksForTests({
      cancel: async () => ({ status: "pending" }),
      brake: async () => {},
      runningContainers: async () => 2,
      restore: async (_app, max) => {
        restored.push(max);
      },
      readMax: async () => 20,
      containerWaitMs: 0,
    });
    const stuck = admitRemoteCall({
      provider: "s2-clone",
      path: "book",
      jobId: "book-stuck",
      sections: ["0"],
      callId: "fc-stuck",
    });
    if (stuck.kind === "start") stuck.finish("still_live");
    const report = await drainBookCalls("book-stuck", "cancelled");
    expect(restored).toEqual([20]);
    expect(report?.stillLive).toEqual(["fc-stuck"]);
    expect(remoteFlights().find((flight) => flight.callId === "fc-stuck")?.status).toBe(
      "still_live"
    );

    restored.length = 0;
    resetRemoteLayerForTests();
    setDrainHooksForTests({
      cancel: async () => ({ status: "pending" }),
      brake: async () => {
        throw new Error("brake exploded");
      },
      runningContainers: async () => 1,
      restore: async (_app, max) => {
        restored.push(max);
      },
      readMax: async () => 12,
      containerWaitMs: 0,
    });
    const blown = admitRemoteCall({
      provider: "s2-clone",
      path: "book",
      jobId: "book-blown",
      sections: ["0"],
      callId: "fc-blown",
    });
    if (blown.kind === "start") blown.finish("still_live");
    await drainBookCalls("book-blown", "cancelled");
    expect(restored).toEqual([12]);
  });

  it("does not brake when another S2 book becomes live before the brake", async () => {
    let braked = false;
    setDrainHooksForTests({
      cancel: async () => {
        const other = admitRemoteCall({
          provider: "s2-clone",
          path: "book",
          jobId: "book-other",
          sections: ["0"],
          callId: "fc-other",
        });
        expect(other.kind).toBe("start");
        return { status: "pending" };
      },
      brake: async () => {
        braked = true;
      },
      runningContainers: async () => 0,
      restore: async () => {},
      readMax: async () => 20,
    });
    const flight = admitRemoteCall({
      provider: "s2-clone",
      path: "book",
      jobId: "book-stop",
      sections: ["0"],
      callId: "fc-stop",
    });
    if (flight.kind === "start") flight.finish("still_live");
    await drainBookCalls("book-stop", "cancelled");
    expect(braked).toBe(false);
  });

  it("heals a brake that was left active only while the live max is still 0", async () => {
    await resetDatabase();
    await saveActiveBrake("echomancer-s2-clone", 17);
    const restored: number[] = [];
    setBrakeHealerForTests(async (_app, max) => {
      restored.push(max);
    });
    setBrakeMaxReaderForTests(async () => 0);
    await reconcileRemoteCalls();
    expect(restored).toEqual([17]);
    expect(await loadActiveBrakes()).toEqual([]);

    await saveActiveBrake("echomancer-s2-clone", 17);
    setBrakeMaxReaderForTests(async () => 12);
    await reconcileRemoteCalls();
    expect(restored).toEqual([17]);
    expect(await loadActiveBrakes()).toEqual([]);
  });

  it("treats a spaced init failure as a terminal cancel", () => {
    expect(interpretCancelResult({ status: "init failure" })).toBe("terminal");
    expect(interpretCancelResult({ status: "pending", threw: "NotFound" })).toBe("still_live");
  });

  it("does not double-count dollars after a reload", async () => {
    await resetDatabase();
    const admitted = admitRemoteCall({
      provider: "s2-clone",
      path: "book",
      jobId: "book-dbl",
      sections: ["0"],
      estCostUsd: 3,
      estMs: 10_000,
    });
    expect(admitted.kind).toBe("start");
    const before = bookSpend("book-dbl").usd;
    const started = remoteEvents().find((event) => event.outcome === "started");
    await persistRemoteEvent(started!);
    const { loadPersistedSpend } = await import("@/lib/remote/store");
    await loadPersistedSpend();
    expect(bookSpend("book-dbl").usd).toBeCloseTo(before);
    expect(bookSpend("book-dbl").usd).toBeCloseTo(3);
  });

  it("closes a prewarm flight when spawn fails and does not report ready", async () => {
    vi.stubEnv("MODAL_TOKEN_ID", "tok");
    setPrewarmSpawnForTests(() => {
      const child = {
        kill() {
          return true;
        },
        on(ev: string, cb: (err: Error) => void) {
          if (ev === "error") queueMicrotask(() => cb(new Error("spawn ENOENT")));
          return child;
        },
      };
      return child as never;
    });
    await expect(prewarmS2Clone()).resolves.toBe("unconfigured");
    const again = admitRemoteCall({
      provider: "prewarm",
      path: "warm",
      sections: ["s2"],
    });
    expect(again.kind).toBe("start");

    resetRemoteLayerForTests();
    const open = admitRemoteCall({
      provider: "prewarm",
      path: "warm",
      sections: ["s2"],
    });
    expect(open.kind).toBe("start");
    await expect(prewarmS2Clone()).resolves.toBe("unconfigured");
    expect(remoteFlights().some((flight) => flight.status === "running")).toBe(true);
  });

  it("SIGKILLs a prewarm child that survives SIGTERM", async () => {
    vi.stubEnv("MODAL_TOKEN_ID", "tok");
    vi.stubEnv("PREWARM_TIMEOUT_MS", "20");
    vi.stubEnv("PREWARM_KILL_MS", "20");
    const signals: string[] = [];
    setPrewarmSpawnForTests(() => {
      const handlers: Record<string, Array<(status?: number) => void>> = {};
      const child = {
        kill(sig?: string) {
          signals.push(sig ?? "");
          if (sig === "SIGKILL") handlers.close?.forEach((fn) => fn(1));
          return true;
        },
        on(ev: string, cb: (status?: number) => void) {
          (handlers[ev] ??= []).push(cb);
          return child;
        },
      };
      return child as never;
    });
    await expect(prewarmS2Clone()).resolves.toBe("unconfigured");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("reads the live autoscaler max instead of MODAL_S2_MAX_GPUS", () => {
    const source = readFileSync(new URL("./drain-book.ts", import.meta.url), "utf8");
    expect(source).toContain("--print-max");
    expect(source).not.toContain("MODAL_S2_MAX_GPUS");
    expect(source).not.toContain("--profile");
    expect(source).not.toContain("ntemusejoel");
    const reconcile = readFileSync(new URL("./reconcile.ts", import.meta.url), "utf8");
    expect(reconcile).not.toContain("--profile");
    expect(reconcile).not.toContain("ntemusejoel");
  });
});
