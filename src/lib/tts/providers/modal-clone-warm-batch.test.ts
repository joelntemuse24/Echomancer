/**
 * In-book ramp for one restored H100.
 *
 * Section 0 is about a minute of audio. A 24-row call after it takes
 * several minutes and returns every row together, so the listener hears
 * that minute and then waits. Each next call is the largest prefix that
 * finishes, with margin, before the audio already buffered ahead of a 1×
 * listener runs out. The prefix grows as that buffer grows.
 *
 * These tests pin the schedule without a GPU:
 *
 *   - the first call of a book stays one section that can survive a cold restore
 *   - the next call is not a full batch
 *   - a 10-hour book played at 1× never stalls after first audio
 *   - every call stays inside the Modal web-proxy budget and the 80 MiB body
 *   - a gap longer than scaledown drops back to one cold-sized call
 *   - two listeners on one GPU never stall once each has started
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
import { FIRST_SECTION_CHARS } from "@/lib/tts/section-size";
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
  simulateClonePlayback,
  simulateTwoCloneListeners,
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

  it("grows the next call from the buffer instead of jumping to 24 rows", () => {
    const plan = planModalCloneBookWave({
      pending: pending(40),
      textAt,
      firstLight: true,
      poolWarm: false,
      batch: 24,
      env,
    });
    const next = plan.calls[1]!;
    expect(next.shape).toBe("warm");
    expect(next.indexes[0]).toBe(1);
    // A 2,000-character section is ~133s of audio. The largest prefix that
    // finishes inside that, at 50 chars/s per row and 150 aggregate, is a
    // handful of rows — not the 24-row call that used to stall playback.
    expect(next.indexes.length).toBeGreaterThanOrEqual(6);
    expect(next.indexes.length).toBeLessThanOrEqual(8);
    expect(next.fitsBuffer).toBe(true);
    expect(next.wallMs).toBeLessThan(next.bufferAtDispatchMs);
    expect(next.chars).toBeGreaterThan(modalLaneCharCap(env));
    expect(next.chars).toBeLessThanOrEqual(modalWarmLaneCharLimit(env));
    expect(plan.calls.some((call) => call.indexes.length === 24)).toBe(true);
    expect([...plan.calls.flatMap((call) => call.indexes), ...plan.deferred]).toEqual(
      pending(40)
    );
    for (const call of plan.calls.slice(1)) {
      expect(call.fitsBuffer).toBe(true);
      expect(call.wallMs).toBeLessThan(call.bufferAtDispatchMs);
      expect(call.waitMs).toBeLessThan(MODAL_CLONE_PROXY_KILL_MS);
    }
  });

  it("sends a later tick as one fat call once the buffer can cover it", () => {
    const plan = planModalCloneBookWave({
      pending: pending(24, 10),
      textAt,
      firstLight: false,
      poolWarm: true,
      batch: 24,
      playbackStarted: true,
      bufferedMs: 30 * 60_000,
      env,
    });
    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0]).toMatchObject({ shape: "warm", fitsBuffer: true });
    expect(plan.calls[0]!.indexes).toEqual(pending(24, 10));
    expect(plan.deferred).toEqual([]);
    expect(plan.parallelLanes).toBe(1);
  });

  it("does not treat a missing buffer as hours of audio already queued", () => {
    const plan = planModalCloneBookWave({
      pending: pending(24),
      textAt,
      firstLight: false,
      poolWarm: true,
      batch: 24,
      env,
    });
    expect(plan.calls[0]!.indexes).toHaveLength(1);
    expect(plan.calls.every((call) => call.indexes.length < 24 || call.bufferAtDispatchMs > call.wallMs)).toBe(
      true
    );
  });

  it("keeps every warm call inside the proxy budget at the packing rate", () => {
    const plan = planModalCloneBookWave({
      pending: pending(24),
      textAt,
      firstLight: false,
      poolWarm: true,
      batch: 24,
      playbackStarted: true,
      bufferedMs: 30 * 60_000,
      env,
    });
    const call = plan.calls[0]!;
    const packedMs = (call.chars / MODAL_LANE_WARM_PACK_CHARS_PER_SECOND) * 1000;
    expect(call.workMs).toBeGreaterThanOrEqual(Math.round(packedMs) - 1);
    expect(call.workMs + MODAL_CLONE_CALL_PREP_MS).toBeLessThanOrEqual(call.waitMs);
    expect(call.waitMs).toBeLessThan(MODAL_CLONE_PROXY_KILL_MS);
    expect(call.waitMs).toBe(modalCloneWarmWaitMs(env));
    expect(call.wallMs).toBeLessThan(MODAL_CLONE_PROXY_KILL_MS);
    expect(call.wallMs).toBeLessThanOrEqual(call.waitMs);
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
      playbackStarted: true,
      bufferedMs: 40 * 60_000,
      env,
    });
    const call = plan.calls[0]!;
    expect(call.indexes.length).toBeLessThanOrEqual(32);
    expect(call.indexes.length).toBeGreaterThan(8);
    expect(call.chars).toBeLessThanOrEqual(modalWarmLaneCharLimit(env));
    expect(call.workMs + MODAL_CLONE_CALL_PREP_MS).toBeLessThanOrEqual(call.waitMs);
    expect(call.wallMs).toBeLessThan(MODAL_CLONE_PROXY_KILL_MS);
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
    // No buffered audio was passed, so the resume does not jump to 24 rows.
    expect(resumed.calls[0]!.indexes.length).toBe(1);
    const deep = planModalCloneBookWave({
      pending: plan.deferred,
      textAt,
      firstLight: false,
      poolWarm: true,
      batch: 24,
      playbackStarted: true,
      bufferedMs: 30 * 60_000,
      env,
    });
    expect(deep.calls[0]!.indexes.length).toBe(24);
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

function tenHourSections(): number[] {
  // Production packer: the first section is ~800 characters and the rest
  // are the clone width, 2,000. 10 hours at 900 characters a minute.
  const totalChars = 10 * 60 * 900;
  const sections = [FIRST_SECTION_CHARS];
  let used = FIRST_SECTION_CHARS;
  while (used < totalChars) {
    const size = Math.min(2_000, totalChars - used);
    sections.push(size);
    used += size;
  }
  return sections;
}

describe("a 10-hour book played at 1×", () => {
  it("never stalls after the first audio", () => {
    const report = simulateClonePlayback({
      sectionChars: tenHourSections(),
      batch: 24,
      env,
    });
    expect(report.stallCount).toBe(0);
    expect(report.steps[0]).toMatchObject({ shape: "cold", rows: 1 });
    // 57s restore + 16s generation of the 800-character section + 12s cold
    // prep + 3s publish + the body transfer. About 88s, not the 5-minute
    // gap a 24-row call used to open.
    expect(report.timeToFirstAudioMs).toBe(88_272);
    expect(report.steps[0]!.wallMs).toBe(88_272);
    expect(report.sizeSequence[0]).toBe(1);
    expect(report.sizeSequence[1]).toBeLessThan(24);
    expect(report.sizeSequence).toContain(24);
    const firstFull = report.sizeSequence.indexOf(24);
    const before = report.sizeSequence.slice(0, firstFull);
    for (let i = 1; i < before.length; i += 1) {
      expect(before[i]).toBeGreaterThanOrEqual(before[i - 1]!);
    }
    for (const step of report.steps) {
      expect(step.wallMs).toBeLessThan(MODAL_CLONE_PROXY_KILL_MS);
      expect(estimateCloneBatchJsonBytes(step.chars)).toBeLessThanOrEqual(
        MODAL_CLONE_RESPONSE_BODY_MAX_BYTES
      );
      if (step.shape === "cold") expect(step.chars).toBeLessThanOrEqual(modalLaneCharCap(env));
    }
    // 1, 1, 8 is the ramp: section 0 is 800 characters (~53s), so the next
    // 2,000-character row is the only call that fits; the buffer is then
    // deep enough for 8. 14 is the rest of the first 24-section claim, sent
    // as one call because that buffer already covers a full batch. Later
    // ticks are 24, and the tail is 7. 4,055,652 ms is about 67.6 minutes
    // of GPU wall for 10 hours of audio, with no idle between calls.
    expect(report.totalWallMs).toBe(4_055_652);
    expect(report.sizeSequence).toEqual([
      1, 1, 8, 14, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 7,
    ]);
  });
});

describe("two books, one GPU", () => {
  const textAt = () => section(2_000);

  it("gives the GPU to one book at a time, and that book's first call is one section", () => {
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
    expect(active.calls).toHaveLength(1);
    expect(active.calls[0]).toMatchObject({ indexes: [0], shape: "cold" });
    expect(active.parallelLanes).toBe(1);
    expect(waiting.calls).toEqual([]);
    expect(waiting.deferred).toEqual(pendingIndexes);
  });

  it("still gives the second book a one-section first call when the pool is already warm", () => {
    const { active, waiting } = planTwoBooksOnOneGpu({
      active: {
        pending: pending(40),
        textAt,
        firstLight: true,
        poolWarm: true,
        playbackStarted: true,
        bufferedMs: 20 * 60_000,
      },
      waiting: {
        pending: pending(10),
        textAt,
        firstLight: true,
        poolWarm: true,
      },
      batch: 24,
      env,
    });
    // The active book has twenty minutes buffered, so the waiting book's
    // first section fits and goes first. It is one row, not a batch.
    expect(waiting.calls).toHaveLength(1);
    expect(waiting.calls[0]!.indexes).toHaveLength(1);
    expect(waiting.calls[0]!.wallMs).toBeLessThan(60_000);
    expect(active.calls).toEqual([]);
  });

  it("does not stall either listener of a 10-hour book", () => {
    const sections = tenHourSections();
    const { reports, totalWallMs, overlapping } = simulateTwoCloneListeners({
      books: [
        { id: "a", sectionChars: sections },
        { id: "b", sectionChars: sections },
      ],
      batch: 24,
      env,
    });
    expect(overlapping).toBe(false);
    expect(reports).toHaveLength(2);
    for (const report of reports) {
      expect(report.stallCount).toBe(0);
      expect(report.sizeSequence[0]).toBe(1);
      expect(report.timeToFirstAudioMs).toBeGreaterThan(0);
      expect(report.steps.every((step) => step.wallMs < MODAL_CLONE_PROXY_KILL_MS)).toBe(true);
    }
    expect(reports[1]!.timeToFirstAudioMs).toBeGreaterThan(reports[0]!.timeToFirstAudioMs);
    // The second listener starts once the first book's buffer can spare one
    // section and still cover its own next row: about 168s, after the first
    // book's cold section and one follow-up row. Early calls stay smaller
    // than the single-book ramp because each call also has to leave the
    // other listener a next section. 8,054,302 ms is both books, one GPU.
    expect(reports[0]!.timeToFirstAudioMs).toBe(88_272);
    expect(reports[1]!.timeToFirstAudioMs).toBe(168_223);
    expect(totalWallMs).toBe(8_054_302);
    expect(reports[0]!.sizeSequence).toEqual([
      1, 1, 3, 21, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 5,
    ]);
    expect(reports[1]!.sizeSequence).toEqual([
      1, 1, 4, 15, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 10,
    ]);
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

  it("renders section 0 cold, then a ramp of warm calls, on the same GPU", async () => {
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
    expect(result.staged).toBe(30);
    const rows = render.mock.calls.map((call) => call[0].map((item: { key: string }) => item.key));
    expect(rows[0]).toEqual(["0"]);
    expect(render.mock.calls[0]![2]?.warmBatch).toBe(false);
    expect(rows[1]!.length).toBeGreaterThan(1);
    expect(rows[1]!.length).toBeLessThan(24);
    expect(render.mock.calls[1]![2]?.warmBatch).toBe(true);
    expect(rows[1]![0]).toBe("1");
    const widths = rows.map((keys) => keys.length);
    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i]).toBeGreaterThan(widths[i - 1]!);
    }
    expect(widths.reduce((sum, n) => sum + n, 0)).toBe(30);
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
      playbackStarted: true,
      bufferedMs: 30 * 60_000,
      render,
      stage: async () => {},
    });
    expect(result.cold).toBe(false);
    expect(kick).not.toHaveBeenCalled();
    // The multi-row call, then one cold section. The other rows wait.
    expect(calls).toBe(2);
    expect(render.mock.calls[0]![0].length).toBeGreaterThan(1);
    expect(render.mock.calls[1]![2]?.warmBatch).toBe(false);
    expect(render.mock.calls[1]![0]).toHaveLength(1);
    kick.mockRestore();
  });
});
