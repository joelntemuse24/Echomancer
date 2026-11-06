/**
 * Four-lane dispatch, provider pinning and cold-start policy.
 *
 * These are the parts of the S2 architecture that are pure decisions, so they
 * are tested without a GPU: how a tick splits into containers, when a book is
 * parked instead of switched, and how a retry stays idempotent.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MODAL_LANE_MIN_CHARS,
  pageLane,
  planModalCloneLanes,
  sectionSeedEpoch,
} from "./modal-clone-lanes";
import {
  CLONE_PROVIDER_PIN_VALUES,
  MODAL_CLONE_COLD_WAIT_MAX_MS,
  MODAL_CLONE_COMPILE_FLOOR_MS,
  cloneTakeIsTruncated,
  modalCloneBatchItems,
  modalCloneColdWaitMs,
  modalCloneDeferMs,
  modalCloneLanes,
  modalCloneRetryDelayMs,
  parseCloneProviderPin,
  resetModalCloneGuardForTests,
} from "./modal-clone-guard";
import { dispatchModalCloneLanes } from "./modal-clone-dispatch";
import {
  ModalCloneColdError,
  ModalCloneLaneBusyError,
  modalCloneCallWait,
  type CloneBatchOutcome,
} from "./modal-clone";
import * as modalCloneWarm from "./modal-clone-warm";

afterEach(() => {
  resetModalCloneGuardForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("lane planning", () => {
  const text = (chars: number) => "x".repeat(chars);

  it("splits a tick across four lanes of one GPU each", () => {
    const sections = new Map<number, string>([
      [0, text(2000)],
      [1, text(2000)],
      [2, text(2000)],
      [3, text(2000)],
      [4, text(2000)],
      [5, text(2000)],
      [6, text(2000)],
      [7, text(2000)],
    ]);
    const plan = planModalCloneLanes({
      pending: [...sections.keys()],
      textAt: (index) => sections.get(index)!,
      limits: { lanes: 4, batch: 24, maxLaneChars: 6000 },
    });
    expect(plan.lanes).toHaveLength(4);
    expect(plan.deferred).toEqual([]);
    // Round-robin by remaining space, two sections per lane.
    for (const lane of plan.lanes) expect(lane).toHaveLength(2);
    expect(plan.lanes.flat().sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("keeps a lane under its character budget so one giant section cannot hog a GPU", () => {
    const sections = new Map<number, string>([
      [0, text(5000)],
      [1, text(5000)],
      [2, text(5000)],
    ]);
    const plan = planModalCloneLanes({
      pending: [0, 1, 2],
      textAt: (index) => sections.get(index)!,
      limits: { lanes: 2, batch: 24, maxLaneChars: 6000 },
    });
    // A 5000-char section fills a 6000-char lane, so the second goes elsewhere
    // and the third spills to a later tick instead of stacking two on a lane.
    expect(plan.lanes.map((lane) => lane.length)).toEqual([1, 1]);
    expect(plan.deferred).toEqual([2]);
  });

  it("fills lanes to the batch cap and defers the overflow", () => {
    const plan = planModalCloneLanes({
      pending: [0, 1, 2, 3, 4],
      textAt: () => text(100),
      limits: { lanes: 1, batch: 3, maxLaneChars: 100_000 },
    });
    expect(plan.lanes).toEqual([[0, 1, 2]]);
    expect(plan.deferred).toEqual([3, 4]);
  });

  it("never makes an empty lane, so one short book uses one container", () => {
    const plan = planModalCloneLanes({
      pending: [0],
      textAt: () => text(50),
      limits: { lanes: 4, batch: 24, maxLaneChars: 6000 },
    });
    expect(plan.lanes).toEqual([[0]]);
  });

  it("keeps ascending index order inside a lane", () => {
    const plan = planModalCloneLanes({
      pending: [3, 1, 9, 4],
      textAt: () => text(120),
      limits: { lanes: 2, batch: 24, maxLaneChars: 10_000 },
    });
    for (const lane of plan.lanes) {
      expect([...lane].sort((a, b) => a - b)).toEqual(lane);
    }
  });

  it("pages a lane whose indexes exceed one call", () => {
    expect(pageLane([0, 1, 2, 3, 4], 2)).toEqual([[0, 1], [2, 3], [4]]);
  });

  it("rejects nonsense limits instead of guessing", () => {
    expect(() =>
      planModalCloneLanes({
        pending: [0],
        textAt: () => "x",
        limits: { lanes: 0, batch: 24, maxLaneChars: 1000 },
      })
    ).toThrow(/lanes/);
  });

  it("has a floor worth a container", () => {
    expect(MODAL_LANE_MIN_CHARS).toBeGreaterThan(0);
  });
});

describe("retry epoch", () => {
  it("stays at zero until a section has actually been attempted", () => {
    expect(sectionSeedEpoch(0)).toBe(0);
    expect(sectionSeedEpoch(1)).toBe(1);
    expect(sectionSeedEpoch(2.7)).toBe(2);
    expect(sectionSeedEpoch(-3)).toBe(0);
  });
});

describe("provider pinning", () => {
  it("accepts exactly the three known engines", () => {
    expect(CLONE_PROVIDER_PIN_VALUES).toEqual(["modal", "drama3", "fish"]);
    expect(parseCloneProviderPin("modal")).toBe("modal");
    expect(parseCloneProviderPin(" Drama3 ")).toBe("drama3");
    expect(parseCloneProviderPin("openrouter")).toBeNull();
    expect(parseCloneProviderPin(null)).toBeNull();
    expect(parseCloneProviderPin(42)).toBeNull();
  });

  it("keeps the narrator fixed for a book that is already pinned", async () => {
    const { resolveCloneProviderPin } = await import("@/lib/tts/process-job");
    // A pinned row wins over a changed env: the book keeps its narrator.
    expect(parseCloneProviderPin("drama3")).toBe("drama3");
    // A new book with Modal configured is pinned to Modal.
    expect(
      resolveCloneProviderPin({
        modalConfigured: true,
        jobBlocked: false,
        env: {} as NodeJS.ProcessEnv,
      })
    ).toBe("modal");
  });

  it("pins to the explicit rollback engine when the env says so", async () => {
    const { resolveCloneProviderPin } = await import("@/lib/tts/process-job");
    expect(
      resolveCloneProviderPin({
        modalConfigured: true,
        jobBlocked: false,
        env: { CLONE_TTS_PROVIDER: "openrouter" } as NodeJS.ProcessEnv,
      })
    ).toBe("drama3");
    expect(
      resolveCloneProviderPin({
        modalConfigured: true,
        jobBlocked: false,
        env: { CLONE_TTS_PROVIDER: "fish" } as NodeJS.ProcessEnv,
      })
    ).toBe("fish");
  });

  it("never pins to Modal without an endpoint or once the budget is spent", async () => {
    const { resolveCloneProviderPin } = await import("@/lib/tts/process-job");
    expect(
      resolveCloneProviderPin({
        modalConfigured: false,
        jobBlocked: false,
        env: {} as NodeJS.ProcessEnv,
      })
    ).toBe("drama3");
    expect(
      resolveCloneProviderPin({
        modalConfigured: true,
        jobBlocked: true,
        env: {} as NodeJS.ProcessEnv,
      })
    ).toBe("drama3");
  });
});

describe("cold start and deferral knobs", () => {
  it("targets four lanes by default and clamps to eight", () => {
    vi.stubEnv("MODAL_S2_SECTION_CONCURRENCY", "");
    expect(modalCloneLanes()).toBe(4);
    vi.stubEnv("MODAL_S2_SECTION_CONCURRENCY", "1");
    expect(modalCloneLanes()).toBe(1);
    vi.stubEnv("MODAL_S2_SECTION_CONCURRENCY", "16");
    expect(modalCloneLanes()).toBe(8);
  });

  it("keeps rows per call at or under the container's decode batch", () => {
    vi.stubEnv("MODAL_S2_BATCH_SIZE", "");
    expect(modalCloneBatchItems()).toBe(24);
    vi.stubEnv("MODAL_S2_BATCH_SIZE", "999");
    expect(modalCloneBatchItems()).toBe(32);
    vi.stubEnv("MODAL_S2_BATCH_SIZE", "7");
    expect(modalCloneBatchItems()).toBe(7);
  });

  it("waits a restore-sized window for a cold container, not a compile", () => {
    vi.stubEnv("MODAL_S2_COLD_WAIT_MS", "");
    expect(modalCloneColdWaitMs()).toBe(150_000);
    vi.stubEnv("MODAL_S2_COLD_WAIT_MS", "0");
    expect(modalCloneColdWaitMs()).toBe(0);
    // A 16-minute setting must not leak into a book. The ceiling is under a compile.
    vi.stubEnv("MODAL_S2_COLD_WAIT_MS", String(16 * 60_000));
    expect(modalCloneColdWaitMs()).toBe(MODAL_CLONE_COLD_WAIT_MAX_MS);
    expect(modalCloneColdWaitMs()).toBeLessThan(MODAL_CLONE_COMPILE_FLOOR_MS);
    expect(modalCloneCallWait(false).ms).toBeLessThan(MODAL_CLONE_COMPILE_FLOOR_MS);
    expect(modalCloneCallWait(false).kind).toBe("restore");
    expect(modalCloneCallWait(true).ms).toBeLessThanOrEqual(60_000);
    expect(modalCloneCallWait(true).kind).toBe("steady");
  });

  it("defers a book rather than switching narrator, with a rollback switch", () => {
    vi.stubEnv("MODAL_S2_DEFER_MS", "");
    expect(modalCloneDeferMs()).toBe(25 * 60_000);
    // 0 = old fail-fast behaviour, for an emergency rollback.
    vi.stubEnv("MODAL_S2_DEFER_MS", "0");
    expect(modalCloneDeferMs()).toBe(0);
    vi.stubEnv("MODAL_S2_DEFER_MS", "-1");
    expect(modalCloneDeferMs()).toBe(25 * 60_000);
    vi.stubEnv("MODAL_S2_DEFER_MS", "999999999");
    expect(modalCloneDeferMs()).toBe(6 * 60 * 60_000);
  });

  it("backs off between retries without hammering a down endpoint", () => {
    expect(modalCloneRetryDelayMs(1)).toBe(15_000);
    expect(modalCloneRetryDelayMs(2)).toBe(30_000);
    expect(modalCloneRetryDelayMs(3)).toBe(60_000);
    expect(modalCloneRetryDelayMs(10)).toBe(120_000);
  });

  it("still rejects a take that is far too short for its text", () => {
    const long = "word ".repeat(200);
    expect(
      cloneTakeIsTruncated({ text: long, durationSeconds: 12, truncatedUnits: 0 }).truncated
    ).toBe(true);
    expect(
      cloneTakeIsTruncated({ text: long, durationSeconds: 50, truncatedUnits: 0 }).truncated
    ).toBe(false);
  });
});

describe("lane dispatch", () => {
  function outcome(keys: string[], containerId: string): CloneBatchOutcome {
    const audio = new Map<string, { audio: Buffer; durationSeconds: number }>();
    for (const key of keys) {
      audio.set(key, { audio: Buffer.from("mp3"), durationSeconds: 30 });
    }
    return {
      audio,
      build: "abc123def456",
      containerId,
      seed: 1,
      performance: { generate_s: 10 },
    };
  }

  it("stages every index and reports which containers answered", async () => {
    const render = vi.fn(async (items) =>
      outcome(
        items.map((item) => item.key),
        `c-${items[0]!.key}`
      )
    );
    const stage = vi.fn(async () => {});
    const result = await dispatchModalCloneLanes({
      indexes: [0, 1, 2, 3],
      textAt: () => "x".repeat(500),
      lanes: 4,
      batch: 24,
      maxLaneChars: 5000,
      seedEpoch: 0,
      render,
      stage,
    });
    expect(result.staged).toBe(4);
    expect(result.missing).toEqual([]);
    expect(result.cold).toBe(false);
    expect(result.containers).toHaveLength(4);
    expect(result.builds).toEqual(["abc123def456"]);
    expect(result.generateSeconds).toBe(40);
    expect(stage).toHaveBeenCalledTimes(4);
  });

  it("reports a cold pool once and stops, instead of opening more containers", async () => {
    const kick = vi.spyOn(modalCloneWarm, "kickModalCloneSnapshotWarm").mockReturnValue(true);
    const render = vi.fn(async () => {
      throw new ModalCloneColdError("no warm container");
    });
    const result = await dispatchModalCloneLanes({
      indexes: [0, 1, 2, 3],
      textAt: () => "x".repeat(500),
      lanes: 4,
      batch: 24,
      maxLaneChars: 5000,
      seedEpoch: 0,
      render,
      stage: async () => {},
    });
    expect(result.cold).toBe(true);
    expect(result.staged).toBe(0);
    expect(result.missing).toEqual([0, 1, 2, 3]);
    // One wave. A pool that is already empty is not retried into a compile.
    expect(render).toHaveBeenCalledTimes(4);
    expect(kick).not.toHaveBeenCalled();
  });

  it("retries a placement that missed the restore budget on another container", async () => {
    const kick = vi.spyOn(modalCloneWarm, "kickModalCloneSnapshotWarm").mockReturnValue(true);
    const failed = new Set<string>();
    const render = vi.fn(async (items: { key: string }[]) => {
      const key = items[0]!.key;
      if (key === "0" && !failed.has(key)) {
        failed.add(key);
        throw new ModalCloneColdError("did not answer within 150s", 30_000, "placement");
      }
      return outcome(
        items.map((item) => item.key),
        `c-${key}`
      );
    });
    const result = await dispatchModalCloneLanes({
      indexes: [0, 1],
      textAt: () => "x".repeat(500),
      lanes: 2,
      batch: 24,
      maxLaneChars: 5000,
      seedEpoch: 0,
      render,
      stage: async () => {},
    });
    expect(result.cold).toBe(false);
    expect(result.staged).toBe(2);
    expect(result.missing).toEqual([]);
    // Two lanes, then one retry for the placement that missed the budget.
    expect(render).toHaveBeenCalledTimes(3);
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it("parks after one retry when every placement misses the restore budget", async () => {
    const kick = vi.spyOn(modalCloneWarm, "kickModalCloneSnapshotWarm").mockReturnValue(true);
    const render = vi.fn(async () => {
      throw new ModalCloneColdError("did not answer within 150s", 30_000, "placement");
    });
    const result = await dispatchModalCloneLanes({
      indexes: [0, 1],
      textAt: () => "x".repeat(500),
      lanes: 2,
      batch: 24,
      maxLaneChars: 5000,
      seedEpoch: 0,
      render,
      stage: async () => {},
    });
    expect(result.cold).toBe(true);
    expect(result.staged).toBe(0);
    expect(result.missing).toEqual([0, 1]);
    // First wave plus one retry wave. Not a compile-length loop.
    expect(render).toHaveBeenCalledTimes(4);
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it("treats a busy lane as retryable, not cold", async () => {
    // A 429 from the container means its single GPU lane is rendering. Parking
    // the book for that would be wrong: the sections are simply unclaimed.
    const render = vi.fn(async () => {
      throw new ModalCloneLaneBusyError("lane busy");
    });
    const result = await dispatchModalCloneLanes({
      indexes: [0, 1],
      textAt: () => "x".repeat(500),
      lanes: 2,
      batch: 24,
      maxLaneChars: 5000,
      seedEpoch: 0,
      render,
      stage: async () => {},
    });
    expect(result.cold).toBe(false);
    expect(result.busy).toBe(2);
    expect(result.staged).toBe(0);
    expect(result.missing).toEqual([0, 1]);
  });

  it("leaves an unreturned section for the per-section path", async () => {
    const render = vi.fn(async (items) => {
      // The server dropped the last row without an error, which the client
      // treats as "not rendered" rather than "rendered as silence".
      const keys = items.map((item) => item.key).slice(0, 1);
      return outcome(keys, "c-1");
    });
    const result = await dispatchModalCloneLanes({
      indexes: [0, 1],
      textAt: () => "x".repeat(500),
      lanes: 2,
      batch: 24,
      maxLaneChars: 5000,
      seedEpoch: 0,
      render,
      stage: async () => {},
    });
    expect(result.staged).toBe(2);
    expect(result.missing).toEqual([]);
  });

  it("does nothing when there is nothing to render", async () => {
    const render = vi.fn();
    const result = await dispatchModalCloneLanes({
      indexes: [],
      textAt: () => "",
      lanes: 4,
      batch: 24,
      maxLaneChars: 5000,
      seedEpoch: 0,
      render,
      stage: async () => {},
    });
    expect(result.staged).toBe(0);
    expect(render).not.toHaveBeenCalled();
  });
});
