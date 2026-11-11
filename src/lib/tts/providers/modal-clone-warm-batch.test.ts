/**
 * Warm full-batch sizing for one restored H100.
 *
 * Production runs `MODAL_S2_READY=0`, so every call used to be packed as if it
 * might still be restoring: ~8,000 characters, about four sections, on a GPU
 * whose batch is 24–32. A restored container is memory-bandwidth bound, so
 * those empty rows are the cost. These tests pin the schedule without a GPU:
 *
 *   - the first call of a book stays one small section that can survive a
 *     cold restore
 *   - once that container has answered, later calls fill one batch
 *   - every call is planned to finish inside the Modal web-proxy budget
 *   - a gap longer than scaledown drops back to the cold-sized call
 *   - two books never open two calls at once
 */

import { describe, expect, it, vi } from "vitest";
import { dispatchModalCloneLanes } from "@/lib/tts/providers/modal-clone-dispatch";
import {
  ModalCloneColdError,
  modalCloneCallWait,
} from "@/lib/tts/providers/modal-clone";
import * as modalCloneWarm from "@/lib/tts/providers/modal-clone-warm";
import {
  MODAL_CLONE_CALL_PREP_MS,
  MODAL_CLONE_COLD_WAIT_MAX_MS,
  MODAL_CLONE_PROXY_KILL_MS,
  MODAL_CLONE_WARM_HOLD_DEFAULT_MS,
  MODAL_CLONE_WARM_WAIT_DEFAULT_MS,
  modalCloneWarmHoldMs,
  modalCloneWarmWaitMs,
} from "@/lib/tts/providers/modal-clone-guard";
import {
  MODAL_LANE_WARM_CHARS_PER_SECOND,
  MODAL_LANE_WARM_PACK_CHARS_PER_SECOND,
  MODAL_CLONE_RESPONSE_BODY_MAX_BYTES,
  clonePoolStillWarm,
  estimateCloneBatchJsonBytes,
  modalLaneCharCap,
  modalWarmLaneCharLimit,
  planModalCloneBookWave,
  planTwoBooksOnOneGpu,
} from "@/lib/tts/providers/modal-clone-lanes";

const env = {} as NodeJS.ProcessEnv;
const section = (chars: number) => "x".repeat(chars);

function pending(n: number, from = 0): number[] {
  return Array.from({ length: n }, (_, i) => from + i);
}

describe("warm batch constants", () => {
  it("sizes calls at a conservative full-batch rate, not the old 2,900", () => {
    // 35× realtime × 15 chars per audio second is the low end of the
    // documented full-batch band. Packing uses a lower rate so a call still
    // finishes if the GPU only partly realizes that band.
    expect(MODAL_LANE_WARM_CHARS_PER_SECOND).toBe(525);
    expect(MODAL_LANE_WARM_PACK_CHARS_PER_SECOND).toBeGreaterThan(100);
    expect(MODAL_LANE_WARM_PACK_CHARS_PER_SECOND).toBeLessThan(
      MODAL_LANE_WARM_CHARS_PER_SECOND
    );
    expect(MODAL_LANE_WARM_PACK_CHARS_PER_SECOND).toBe(150);
  });

  it("gives a warm batch the long wait and does not call that a compile", () => {
    const wait = modalCloneCallWait(false, false, 0, true);
    expect(wait.kind).toBe("warm");
    expect(wait.ms).toBe(MODAL_CLONE_WARM_WAIT_DEFAULT_MS);
    expect(wait.ms).toBeLessThan(MODAL_CLONE_PROXY_KILL_MS);
    // Cold and steady calls are unchanged by the extra argument.
    expect(modalCloneCallWait(false, false, 10 * 60_000).ms).toBe(
      MODAL_CLONE_COLD_WAIT_MAX_MS
    );
    expect(modalCloneCallWait(false).kind).toBe("restore");
  });

  it("keeps the warm HTTP wait under the proxy kill", () => {
    expect(MODAL_CLONE_PROXY_KILL_MS).toBe(542_000);
    expect(MODAL_CLONE_WARM_WAIT_DEFAULT_MS).toBe(400_000);
    expect(modalCloneWarmWaitMs(env)).toBeLessThan(MODAL_CLONE_PROXY_KILL_MS);
    expect(modalCloneWarmWaitMs(env)).toBeGreaterThan(MODAL_CLONE_COLD_WAIT_MAX_MS);
    // An override cannot reach the proxy kill.
    expect(
      modalCloneWarmWaitMs({ MODAL_S2_WARM_WAIT_MS: "999999" } as NodeJS.ProcessEnv)
    ).toBeLessThan(MODAL_CLONE_PROXY_KILL_MS);
  });

  it("treats the pool as warm only inside the scaledown hold", () => {
    expect(MODAL_CLONE_WARM_HOLD_DEFAULT_MS).toBe(165_000);
    expect(modalCloneWarmHoldMs(env)).toBe(165_000);
    expect(clonePoolStillWarm(100_000, 0, env)).toBe(true);
    expect(clonePoolStillWarm(165_000, 0, env)).toBe(true);
    expect(clonePoolStillWarm(165_001, 0, env)).toBe(false);
    expect(clonePoolStillWarm(50_000, null, env)).toBe(false);
  });
});

describe("one book's call schedule", () => {
  const textAt = () => section(2_000);

  it("keeps the first call to one section sized for a cold restore", () => {
    const plan = planModalCloneBookWave({
      pending: pending(40),
      textAt,
      firstLight: true,
      poolWarm: false,
      batch: 24,
      env,
    });
    expect(plan.parallelLanes).toBe(1);
    expect(plan.calls[0]).toMatchObject({
      indexes: [0],
      shape: "cold",
    });
    expect(plan.calls[0]!.chars).toBe(2_000);
    expect(plan.calls[0]!.chars).toBeLessThanOrEqual(modalLaneCharCap(env));
    expect(plan.calls[0]!.waitMs).toBeLessThanOrEqual(MODAL_CLONE_COLD_WAIT_MAX_MS);
    expect(plan.calls[0]!.workMs + MODAL_CLONE_CALL_PREP_MS).toBeLessThanOrEqual(
      plan.calls[0]!.waitMs
    );
  });

  it("fills the next call to a full batch once the container has answered", () => {
    const plan = planModalCloneBookWave({
      pending: pending(40),
      textAt,
      firstLight: true,
      poolWarm: false,
      batch: 24,
      env,
    });
    const fat = plan.calls[1]!;
    expect(fat.shape).toBe("warm");
    expect(fat.indexes).toHaveLength(24);
    expect(fat.indexes[0]).toBe(1);
    expect(fat.chars).toBe(48_000);
    expect(fat.chars).toBeGreaterThan(modalLaneCharCap(env));
    expect(fat.chars).toBeLessThanOrEqual(modalWarmLaneCharLimit(env));
    expect(plan.deferred).toEqual(pending(15, 25));
    // Playback order: cold section, then the fat call, then the tail.
    expect([...plan.calls.flatMap((call) => call.indexes), ...plan.deferred]).toEqual(
      pending(40)
    );
  });

  it("sends a later tick as one fat call, not four thin ones", () => {
    const plan = planModalCloneBookWave({
      pending: pending(30, 10),
      textAt,
      firstLight: false,
      poolWarm: true,
      batch: 24,
      env,
    });
    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0]).toMatchObject({ shape: "warm" });
    expect(plan.calls[0]!.indexes).toEqual(pending(24, 10));
    expect(plan.deferred).toEqual(pending(6, 34));
    expect(plan.parallelLanes).toBe(1);
  });

  it("keeps every warm call inside the proxy budget at the packing rate", () => {
    const plan = planModalCloneBookWave({
      pending: pending(24),
      textAt,
      firstLight: false,
      poolWarm: true,
      batch: 24,
      env,
    });
    const call = plan.calls[0]!;
    const packedMs = (call.chars / MODAL_LANE_WARM_PACK_CHARS_PER_SECOND) * 1000;
    expect(call.workMs).toBeGreaterThanOrEqual(Math.round(packedMs) - 1);
    expect(call.workMs + MODAL_CLONE_CALL_PREP_MS).toBeLessThanOrEqual(call.waitMs);
    expect(call.waitMs).toBeLessThan(MODAL_CLONE_PROXY_KILL_MS);
    expect(call.waitMs).toBe(modalCloneWarmWaitMs(env));
    // The expected 35× rate is faster than the rate we pack against, and
    // both finish well under the proxy. 2,900 chars/s would have scheduled
    // a call this budget cannot survive.
    const expectedMs = (call.chars / MODAL_LANE_WARM_CHARS_PER_SECOND) * 1000;
    expect(expectedMs).toBeLessThan(call.workMs);
    expect(expectedMs + MODAL_CLONE_CALL_PREP_MS).toBeLessThan(120_000);
    expect(estimateCloneBatchJsonBytes(call.chars)).toBeLessThanOrEqual(
      MODAL_CLONE_RESPONSE_BODY_MAX_BYTES
    );
  });

  it("does not let a raised batch swallow a call the proxy cannot finish", () => {
    const plan = planModalCloneBookWave({
      pending: pending(40),
      textAt: () => section(2_000),
      firstLight: false,
      poolWarm: true,
      batch: 32,
      env,
    });
    const call = plan.calls[0]!;
    expect(call.indexes.length).toBeLessThanOrEqual(32);
    expect(call.chars).toBeLessThanOrEqual(modalWarmLaneCharLimit(env));
    expect(call.workMs + MODAL_CLONE_CALL_PREP_MS).toBeLessThanOrEqual(call.waitMs);
    expect(call.waitMs).toBeLessThan(MODAL_CLONE_PROXY_KILL_MS);
    expect(estimateCloneBatchJsonBytes(call.chars)).toBeLessThanOrEqual(
      MODAL_CLONE_RESPONSE_BODY_MAX_BYTES
    );
  });

  it("falls back to a cold-sized call when the container has scaled to zero", () => {
    expect(clonePoolStillWarm(200_000, 0, env)).toBe(false);
    const plan = planModalCloneBookWave({
      pending: pending(30, 4),
      textAt,
      firstLight: false,
      poolWarm: false,
      batch: 24,
      env,
    });
    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0]!.shape).toBe("cold");
    expect(plan.calls[0]!.chars).toBeLessThanOrEqual(modalLaneCharCap(env));
    expect(plan.calls[0]!.indexes.length).toBeLessThanOrEqual(4);
    expect(plan.calls[0]!.waitMs).toBeLessThanOrEqual(MODAL_CLONE_COLD_WAIT_MAX_MS);
    expect(plan.deferred.length).toBeGreaterThan(0);
    // The next successful answer is what unlocks fat batches again.
    const resumed = planModalCloneBookWave({
      pending: plan.deferred,
      textAt,
      firstLight: false,
      poolWarm: true,
      batch: 24,
      env,
    });
    expect(resumed.calls[0]!.shape).toBe("warm");
    expect(resumed.calls[0]!.indexes.length).toBe(24);
  });

  it("lets an operator shrink a warm call but not enlarge it past the budget", () => {
    expect(
      modalWarmLaneCharLimit({ MODAL_S2_WARM_LANE_MAX_CHARS: "8000" } as NodeJS.ProcessEnv)
    ).toBe(8_000);
    expect(
      modalWarmLaneCharLimit({
        MODAL_S2_WARM_LANE_MAX_CHARS: "500000",
      } as NodeJS.ProcessEnv)
    ).toBe(modalWarmLaneCharLimit(env));
    expect(modalWarmLaneCharLimit(env)).toBeGreaterThan(modalLaneCharCap(env));
    expect(modalWarmLaneCharLimit(env)).toBeGreaterThanOrEqual(24 * 2_000);
  });
});

describe("a 10-hour book", () => {
  it("is many proxy-safe calls on one lane, not one HTTP request", () => {
    const sectionChars = 2_000;
    const totalChars = 10 * 60 * 900;
    const count = Math.ceil(totalChars / sectionChars);
    let pendingIndexes = pending(count);
    const calls: Array<{ shape: "cold" | "warm"; chars: number; workMs: number; waitMs: number; indexes: number[] }> = [];
    let poolWarm = false;
    let guard = 0;
    while (pendingIndexes.length > 0 && guard < 40) {
      guard += 1;
      const window = pendingIndexes.slice(0, 24);
      const plan = planModalCloneBookWave({
        pending: window,
        textAt: () => section(sectionChars),
        firstLight: window[0] === 0 && !poolWarm,
        poolWarm,
        batch: 24,
        env,
      });
      expect(plan.parallelLanes).toBe(1);
      expect(plan.calls.length).toBeGreaterThan(0);
      for (const call of plan.calls) {
        expect(call.waitMs).toBeLessThan(MODAL_CLONE_PROXY_KILL_MS);
        expect(call.workMs + MODAL_CLONE_CALL_PREP_MS).toBeLessThanOrEqual(call.waitMs);
        calls.push(call);
      }
      const taken = new Set(plan.calls.flatMap((call) => call.indexes));
      pendingIndexes = pendingIndexes.filter((index) => !taken.has(index));
      poolWarm = true;
    }
    expect(pendingIndexes).toEqual([]);
    expect(calls[0]).toMatchObject({ shape: "cold", indexes: [0] });
    const warm = calls.filter((call) => call.shape === "warm");
    expect(warm.length).toBeGreaterThan(8);
    expect(warm.every((call) => call.indexes.length <= 24)).toBe(true);
    const packedMs = warm.reduce((sum, call) => sum + call.workMs, 0);
    // At the packing rate (150 chars/s) the narration itself is about an
    // hour. At the expected 35× rate it is under half an hour. Either way
    // it is not a 3-hour one-row read and not a single proxy-killed call.
    expect(packedMs).toBeGreaterThan(40 * 60_000);
    expect(packedMs).toBeLessThan(80 * 60_000);
    const expectedMs = (totalChars / MODAL_LANE_WARM_CHARS_PER_SECOND) * 1000;
    expect(expectedMs).toBeLessThan(30 * 60_000);
  });
});

describe("two books, one GPU", () => {
  const textAt = () => section(2_000);

  it("lets only the active book open a call", () => {
    const pendingIndexes = pending(40);
    const { active, waiting } = planTwoBooksOnOneGpu({
      active: {
        pending: pendingIndexes,
        textAt,
        firstLight: true,
        poolWarm: false,
      },
      waiting: {
        pending: pendingIndexes,
        textAt,
        firstLight: true,
        poolWarm: false,
      },
      batch: 24,
      env,
    });
    expect(active.calls.length).toBeGreaterThan(0);
    expect(active.parallelLanes).toBe(1);
    expect(waiting.calls).toEqual([]);
    expect(waiting.deferred).toEqual(pendingIndexes);
    // The calls one book does make are sequential: section 0, then one batch.
    expect(active.calls.map((call) => call.shape)).toEqual(["cold", "warm"]);
  });

  it("still gives the second book a small first call when the pool is already warm", () => {
    const { active } = planTwoBooksOnOneGpu({
      active: {
        pending: pending(40),
        textAt,
        firstLight: true,
        poolWarm: true,
      },
      waiting: {
        pending: pending(10),
        textAt,
        firstLight: false,
        poolWarm: true,
      },
      batch: 24,
      env,
    });
    expect(active.calls[0]).toMatchObject({ indexes: [0], shape: "cold" });
    expect(active.calls[1]!.shape).toBe("warm");
    expect(active.calls[1]!.indexes.length).toBeGreaterThan(8);
  });
});

describe("book-wave dispatch", () => {
  const textAt = () => section(2_000);

  function outcome(keys: string[]) {
    const audio = new Map<string, { audio: Buffer; durationSeconds: number }>();
    for (const key of keys) audio.set(key, { audio: Buffer.from("mp3"), durationSeconds: 12 });
    return {
      audio,
      build: "abc",
      containerId: "gpu-1",
      seed: 1,
      performance: { generate_s: 4 },
      boot: "restored" as const,
    };
  }

  it("renders section 0 cold, then one warm batch, on the same GPU", async () => {
    const render = vi.fn(async (items: { key: string }[]) =>
      outcome(items.map((item) => item.key))
    );
    const result = await dispatchModalCloneLanes({
      indexes: pending(30),
      textAt,
      lanes: 4,
      batch: 24,
      maxLaneChars: 8_000,
      seedEpoch: 0,
      firstLight: true,
      bookWave: true,
      poolWarm: false,
      render,
      stage: async () => {},
    });
    expect(result.cold).toBe(false);
    expect(result.staged).toBe(25);
    expect(render).toHaveBeenCalledTimes(2);
    const first = render.mock.calls[0]!;
    const second = render.mock.calls[1]!;
    expect(first[0].map((item: { key: string }) => item.key)).toEqual(["0"]);
    expect(first[2]?.warmBatch).toBe(false);
    expect(second[0]).toHaveLength(24);
    expect(second[2]?.warmBatch).toBe(true);
    expect(second[0][0].key).toBe("1");
  });

  it("does not open the fat batch when section 0 cannot be placed", async () => {
    const kick = vi.spyOn(modalCloneWarm, "kickModalCloneSnapshotWarm").mockReturnValue(true);
    const render = vi.fn(async () => {
      throw new ModalCloneColdError("restore missed", 30_000, "placement");
    });
    const result = await dispatchModalCloneLanes({
      indexes: pending(12),
      textAt,
      lanes: 4,
      batch: 24,
      maxLaneChars: 8_000,
      seedEpoch: 0,
      firstLight: true,
      bookWave: true,
      poolWarm: false,
      render,
      stage: async () => {},
    });
    expect(render).toHaveBeenCalledTimes(2);
    expect(render.mock.calls.every((call) => call[0].map((item: { key: string }) => item.key).join() === "0")).toBe(true);
    expect(result.cold).toBe(true);
    expect(result.staged).toBe(0);
    kick.mockRestore();
  });

  it("does not kick a compile when a warm batch misses its budget", async () => {
    const kick = vi.spyOn(modalCloneWarm, "kickModalCloneSnapshotWarm").mockReturnValue(true);
    let calls = 0;
    const render = vi.fn(async (items: { key: string }[], _epoch: number, opts?: { warmBatch?: boolean }) => {
      calls += 1;
      if (opts?.warmBatch) {
        throw new ModalCloneColdError("warm batch slow", 30_000, "placement");
      }
      return outcome(items.map((item) => item.key));
    });
    const result = await dispatchModalCloneLanes({
      indexes: pending(10, 4),
      textAt,
      lanes: 4,
      batch: 24,
      maxLaneChars: 8_000,
      seedEpoch: 0,
      firstLight: false,
      bookWave: true,
      poolWarm: true,
      render,
      stage: async () => {},
    });
    expect(result.cold).toBe(false);
    expect(kick).not.toHaveBeenCalled();
    // The fat call, then one cold section. The other rows wait.
    expect(calls).toBe(2);
    expect(render.mock.calls[1]![2]?.warmBatch).toBe(false);
    expect(render.mock.calls[1]![0]).toHaveLength(1);
    kick.mockRestore();
  });
});
