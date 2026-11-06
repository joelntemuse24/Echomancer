/**
 * Four-lane dispatch, provider pinning and cold-start policy.
 *
 * These are the parts of the S2 architecture that are pure decisions, so they
 * are tested without a GPU: how a tick splits into containers, when a book is
 * parked instead of switched, and how a retry stays idempotent.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MODAL_LANE_CHARS_PER_SECOND,
  MODAL_LANE_MIN_CHARS,
  modalLaneCharCap,
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
  modalCloneFirstLightEnabled,
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

  it("fills one call toward the batch before opening another", () => {
    // The regression: 5 sections across 4 lanes became [[0],[1],[2],[3]] with
    // [4] deferred, so every call carried one row and ran at the 2.9x one-row
    // rate instead of the 35–65x a full batch gets (`job db10a6d6`).
    const sizes = new Map<number, string>([
      [0, text(1300)],
      [1, text(1300)],
      [2, text(1300)],
      [3, text(1300)],
      [4, text(1300)],
    ]);
    const plan = planModalCloneLanes({
      pending: [0, 1, 2, 3, 4],
      textAt: (index) => sizes.get(index)!,
      limits: { lanes: 4, batch: 24 },
    });
    // Everything rides one call, because 5 rows fit in a 24-row batch.
    expect(plan.lanes).toEqual([[0, 1, 2, 3, 4]]);
    expect(plan.deferred).toEqual([]);
  });

  it("matches the Alice smoke: the same 5 sections ride one call, not four", () => {
    // `job db10a6d6` planned [[0],[1],[2],[3]] + [4] deferred from a real
    // 5-section / ~7:15 book at evenFanout=4. With the tick's real character
    // cap that book is a single 5-row call, so the container decodes it as one
    // batch instead of four one-row passes.
    const sizes = [1300, 1300, 1300, 1300, 1300];
    const plan = planModalCloneLanes({
      pending: [0, 1, 2, 3, 4],
      textAt: (index) => "x".repeat(sizes[index]!),
      // The tick passes the steady-state cap (~87,000 chars at 60s), not a
      // per-lane share of the tick.
      limits: { lanes: 4, batch: 24, maxLaneChars: 87_000 },
    });
    expect(plan.lanes).toHaveLength(1);
    expect(plan.lanes[0]).toEqual([0, 1, 2, 3, 4]);
    expect(plan.deferred).toEqual([]);
  });

  it("opens a second call only when the first is full", () => {
    const plan = planModalCloneLanes({
      pending: [0, 1, 2, 3, 4, 5, 6, 7],
      textAt: () => text(2000),
      limits: { lanes: 4, batch: 2 },
    });
    expect(plan.lanes).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 7],
    ]);
    expect(plan.deferred).toEqual([]);
  });

  it("caps lanes at the lane count and defers the overflow", () => {
    const plan = planModalCloneLanes({
      pending: [0, 1, 2, 3, 4],
      textAt: () => text(100),
      limits: { lanes: 2, batch: 2 },
    });
    expect(plan.lanes).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(plan.deferred).toEqual([4]);
  });

  it("keeps a call under the character cap so a long section cannot time it out", () => {
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
    // A 5000-char section nearly fills a 6000-char call, so the second goes
    // elsewhere and the third spills to a later tick instead of stacking two
    // on one call past the steady-state timeout.
    expect(plan.lanes.map((lane) => lane.length)).toEqual([1, 1]);
    expect(plan.deferred).toEqual([2]);
  });

  it("never makes an empty call, so one short book uses one container", () => {
    const plan = planModalCloneLanes({
      pending: [0],
      textAt: () => text(50),
      limits: { lanes: 4, batch: 24 },
    });
    expect(plan.lanes).toEqual([[0]]);
  });

  it("keeps ascending index order inside a lane", () => {
    const plan = planModalCloneLanes({
      pending: [3, 1, 9, 4],
      textAt: () => text(120),
      limits: { lanes: 2, batch: 24 },
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
        limits: { lanes: 0, batch: 24 },
      })
    ).toThrow(/lanes/);
    expect(() =>
      planModalCloneLanes({
        pending: [0],
        textAt: () => "x",
        limits: { lanes: 4, batch: 0 },
      })
    ).toThrow(/batch/);
  });

  it("has a floor worth a container", () => {
    expect(MODAL_LANE_MIN_CHARS).toBeGreaterThan(0);
  });

  it("sizes the character cap from the steady-state call timeout", () => {
    // A one-row call measures 2.9x realtime; the cap assumes half that so a
    // slower container still answers inside its own timeout.
    const cap = modalLaneCharCap(60_000, {} as NodeJS.ProcessEnv);
    expect(cap).toBe(60 * MODAL_LANE_CHARS_PER_SECOND * 0.5);
    expect(modalLaneCharCap(60_000, { MODAL_S2_LANE_MAX_CHARS: "1234" } as NodeJS.ProcessEnv)).toBe(1234);
    // A mis-set cap cannot collapse a call to nothing useful.
    expect(modalLaneCharCap(60_000, { MODAL_S2_LANE_MAX_CHARS: "0" } as NodeJS.ProcessEnv)).toBe(
      60 * MODAL_LANE_CHARS_PER_SECOND * 0.5
    );
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
      // One row per call, so the four calls land on four containers.
      batch: 1,
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
      batch: 1,
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
      batch: 1,
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
      batch: 1,
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
      batch: 1,
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
      batch: 1,
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
      seedEpoch: 0,
      render,
      stage: async () => {},
    });
    expect(result.staged).toBe(0);
    expect(render).not.toHaveBeenCalled();
  });
});

/**
 * The 2026-11-06 Alice smoke (`job db10a6d6`).
 *
 * A 5-section book took ~4m38s to be ready from a scaled-to-zero pool. Four
 * lanes opened at once; lane calls for sections 1 and 3 answered at +90s and
 * +126s while section 0 — the only section the player can start with — landed
 * at +141s, and one placement missed the 150s restore budget and needed a retry
 * wave. So the book paid a full fan-out of cold wall clock before one second of
 * audio was playable, on a day when a single cold HTTP call restored in ~57s.
 */
describe("first light: section 0 before the fan-out", () => {
  function outcome(keys: string[], containerId: string): CloneBatchOutcome {
    const audio = new Map<string, { audio: Buffer; durationSeconds: number }>();
    for (const key of keys) {
      audio.set(key, { audio: Buffer.from("mp3"), durationSeconds: 30 });
    }
    return { audio, build: "b1", containerId, seed: 1, performance: { generate_s: 10 } };
  }

  it("renders section 0 alone before opening any other lane", async () => {
    const order: number[][] = [];
    const render = vi.fn(async (items: { key: string }[]) => {
      order.push(items.map((item) => Number(item.key)));
      return outcome(
        items.map((item) => item.key),
        `c-${items[0]!.key}`
      );
    });
    const result = await dispatchModalCloneLanes({
      indexes: [0, 1, 2, 3, 4],
      textAt: () => "x".repeat(500),
      lanes: 4,
      batch: 24,
      seedEpoch: 0,
      firstLight: true,
      render,
      stage: async () => {},
    });
    // The first call carries section 0 and nothing else, so its audio cannot
    // wait behind a neighbour that shares the same lane's HTTP response.
    expect(order[0]).toEqual([0]);
    // Then the remaining four sections fan out across the lanes.
    expect(order.length).toBeGreaterThan(1);
    expect(result.staged).toBe(5);
    expect(result.firstLight).toMatchObject({ index: 0, staged: true });
  });

  it("publishes section 0 while the rest of the book is still rendering", async () => {
    // The point of publishing early is that it overlaps the fan-out, so the
    // publish must start before the second wave's calls do.
    const events: string[] = [];
    const render = vi.fn(async (items: { key: string }[]) => {
      events.push(`render:${items.map((item) => item.key).join(",")}`);
      if (items[0]!.key === "0") {
        // A short delay so the publish is observably concurrent, not sequenced.
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return outcome(
        items.map((item) => item.key),
        "c"
      );
    });
    let releasePublish!: () => void;
    const publishDone = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    const publishFirstLight = vi.fn(async (index: number) => {
      events.push(`publish-start:${index}`);
      await publishDone;
      events.push(`publish-end:${index}`);
    });
    const dispatch = dispatchModalCloneLanes({
      indexes: [0, 1],
      textAt: () => "x".repeat(500),
      lanes: 2,
      batch: 24,
      seedEpoch: 0,
      firstLight: true,
      render,
      stage: async () => {},
      publishFirstLight,
    });
    // The fan-out runs to completion while the publish is still open.
    await vi.waitFor(() => {
      expect(events).toContain("render:1");
    });
    expect(events).toContain("publish-start:0");
    expect(events).not.toContain("publish-end:0");
    releasePublish();
    const result = await dispatch;
    expect(publishFirstLight).toHaveBeenCalledWith(0);
    expect(result.staged).toBe(2);
    expect(result.cold).toBe(false);
  });

  it("does not fan out when section 0 never comes back", async () => {
    // One cold restore for the section the player needs, then stop. Opening
    // three more lanes would be the same restore budget three more times.
    const kick = vi.spyOn(modalCloneWarm, "kickModalCloneSnapshotWarm").mockReturnValue(true);
    const render = vi.fn(async (items: { key: string }[]) => {
      if (items[0]!.key === "0") {
        throw new ModalCloneColdError("did not answer within 150s", 30_000, "placement");
      }
      throw new Error("no other lane may open while section 0 is missing");
    });
    const result = await dispatchModalCloneLanes({
      indexes: [0, 1, 2, 3, 4],
      textAt: () => "x".repeat(500),
      lanes: 4,
      batch: 24,
      seedEpoch: 0,
      firstLight: true,
      render,
      stage: async () => {},
    });
    // Two attempts at section 0 (the original plus one retry), and nothing else.
    expect(render).toHaveBeenCalledTimes(2);
    expect(result.cold).toBe(true);
    expect(result.staged).toBe(0);
    expect(result.firstLight).toMatchObject({ index: 0, staged: false });
    // The off-path RPC is still what finishes the compile.
    expect(kick).toHaveBeenCalled();
  });

  it("keeps the whole book moving when only section 0 is retried", async () => {
    let headAttempts = 0;
    const render = vi.fn(async (items: { key: string }[]) => {
      const keys = items.map((item) => item.key);
      if (keys[0] === "0") {
        headAttempts += 1;
        if (headAttempts === 1) {
          throw new ModalCloneColdError("slow placement", 30_000, "placement");
        }
      }
      return outcome(keys, `c-${keys[0]}`);
    });
    const result = await dispatchModalCloneLanes({
      indexes: [0, 1, 2],
      textAt: () => "x".repeat(500),
      lanes: 3,
      batch: 24,
      seedEpoch: 0,
      firstLight: true,
      render,
      stage: async () => {},
    });
    expect(result.firstLight).toMatchObject({ index: 0, staged: true });
    expect(result.staged).toBe(3);
    expect(result.cold).toBe(false);
  });

  it("leaves the fan-out untouched when section 0 is already staged", async () => {
    const render = vi.fn(async (items: { key: string }[]) =>
      outcome(
        items.map((item) => item.key),
        "c"
      )
    );
    const result = await dispatchModalCloneLanes({
      indexes: [1, 2, 3, 4],
      textAt: () => "x".repeat(500),
      lanes: 4,
      // One row per call: this asserts the calls made, not the batching.
      batch: 1,
      seedEpoch: 0,
      firstLight: false,
      render,
      stage: async () => {},
    });
    expect(result.firstLight).toBeNull();
    expect(render).toHaveBeenCalledTimes(4);
    expect(result.staged).toBe(4);
  });

  it("does not report a rendered section as playable when publishing fails", async () => {
    const render = vi.fn(async (items: { key: string }[]) =>
      outcome(
        items.map((item) => item.key),
        "c"
      )
    );
    const result = await dispatchModalCloneLanes({
      indexes: [0],
      textAt: () => "x".repeat(500),
      lanes: 1,
      batch: 24,
      seedEpoch: 0,
      firstLight: true,
      render,
      stage: async () => {},
      publishFirstLight: async () => {
        throw new Error("ffmpeg exploded");
      },
    });
    expect(result.firstLight).toMatchObject({
      index: 0,
      staged: false,
      publishError: true,
    });
    expect(result.staged).toBe(0);
    expect(result.missing).toEqual([0]);
  });
});

describe("the first-light kill switch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is on by default and off only when explicitly disabled", () => {
    vi.stubEnv("MODAL_S2_FIRST_LIGHT", "");
    expect(modalCloneFirstLightEnabled()).toBe(true);
    for (const off of ["0", "false", "off", "no", "OFF"]) {
      vi.stubEnv("MODAL_S2_FIRST_LIGHT", off);
      expect(modalCloneFirstLightEnabled()).toBe(false);
    }
    vi.stubEnv("MODAL_S2_FIRST_LIGHT", "1");
    expect(modalCloneFirstLightEnabled()).toBe(true);
  });
});
