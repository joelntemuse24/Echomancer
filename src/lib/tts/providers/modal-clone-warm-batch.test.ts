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
import {
  MODAL_LANE_WARM_CHARS_PER_SECOND,
  MODAL_LANE_WARM_PACK_CHARS_PER_SECOND,
  MODAL_CLONE_CHARS_PER_AUDIO_SECOND,
  MODAL_CLONE_OPENING_SECTION_CHARS,
  MODAL_CLONE_RESPONSE_BODY_MAX_BYTES,
  MODAL_CLONE_ROW_CHARS_PER_SECOND,
  MODAL_CLONE_SECOND_CALL_CHARS,
  cloneAudioMs,
  cloneCallWallMs,
  cloneGenerationMs,
  clonePoolStillWarm,
  cloneRowCharsPerSecond,
  cloneTransferMs,
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
  it("keeps the warm character cap under the documented full-batch band", () => {
    // 150 still sizes the warm character cap. The listener wall uses the
    // 2026-11-11 smoke curve, which is slower per row as the call gets wider.
    expect(MODAL_LANE_WARM_CHARS_PER_SECOND).toBe(525);
    expect(MODAL_LANE_WARM_PACK_CHARS_PER_SECOND).toBe(150);
    expect(MODAL_CLONE_ROW_CHARS_PER_SECOND).toBe(33);
    expect(cloneRowCharsPerSecond(1)).toBe(33);
    expect(cloneRowCharsPerSecond(8)).toBeCloseTo((266 / 8) * 0.85, 5);
    expect(cloneRowCharsPerSecond(14)).toBeCloseTo((371 / 14) * 0.85, 5);
    expect(cloneRowCharsPerSecond(24)).toBeCloseTo((617 / 24) * 0.85, 5);
    expect(cloneRowCharsPerSecond(24)).toBeLessThan(cloneRowCharsPerSecond(8));
  });

  it("plans at or slower than the 2026-11-11 smoke", () => {
    const smoke = [
      { rows: 1, chars: 673, wallMs: 57_050, restore: true },
      { rows: 1, chars: 1_300, wallMs: 39_850, restore: false },
      { rows: 8, chars: 15_500, wallMs: 62_730, restore: false },
      { rows: 14, chars: 22_185, wallMs: 65_200, restore: false },
      { rows: 24, chars: 43_907, wallMs: 83_180, restore: false },
    ];
    for (const call of smoke) {
      const wall = cloneCallWallMs({
        chars: call.chars,
        largestRow: Math.ceil(call.chars / call.rows),
        rows: call.rows,
        shape: call.restore ? "cold" : "warm",
        restore: call.restore,
      });
      expect(wall).toBeGreaterThanOrEqual(call.wallMs - 500);
      expect(wall).toBeLessThan(call.wallMs * 1.25);
    }
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
    const chars = tenHourSections();
    const plan = planModalCloneBookWave({
      pending: pending(60),
      textAt: (index) => section(chars[index] ?? 2_000),
      firstLight: true,
      poolWarm: false,
      batch: 24,
      env,
    });
    const next = plan.calls[1]!;
    expect(next.shape).toBe("warm");
    expect(next.indexes[0]).toBe(1);
    // Section 0 is 1,000 characters. The next call is the 1,300-character
    // cap, one row, and it leaves the 15s margin. It is not 24 rows.
    expect(next.indexes).toHaveLength(1);
    expect(next.chars).toBe(MODAL_CLONE_SECOND_CALL_CHARS);
    expect(next.fitsBuffer).toBe(true);
    expect(next.bufferAtDispatchMs - next.wallMs).toBeGreaterThanOrEqual(15_000);
    expect(next.chars).toBeLessThanOrEqual(modalWarmLaneCharLimit(env));
    expect(plan.calls.some((call) => call.indexes.length === 24)).toBe(true);
    expect([...plan.calls.flatMap((call) => call.indexes), ...plan.deferred]).toEqual(
      pending(60)
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
    expect(call.workMs).toBe(
      Math.max(
        cloneGenerationMs(call.chars, call.indexes.length),
        cloneGenerationMs(2_000, 1)
      )
    );
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

function cloneBookSections(audioSeconds: number): number[] {
  // The smoke's 15.85 characters per audio second. Section 0 is the clone
  // opening, section 1 is the short second call, and the rest are the
  // steady 2,000-character width.
  const totalChars = Math.round(audioSeconds * MODAL_CLONE_CHARS_PER_AUDIO_SECOND);
  const opening = Math.min(MODAL_CLONE_OPENING_SECTION_CHARS, Math.max(0, totalChars));
  const sections = [opening];
  let used = opening;
  if (used < totalChars) {
    const second = Math.min(MODAL_CLONE_SECOND_CALL_CHARS, totalChars - used);
    sections.push(second);
    used += second;
  }
  while (used < totalChars) {
    const size = Math.min(2_000, totalChars - used);
    sections.push(size);
    used += size;
  }
  return sections;
}

function tenHourSections(): number[] {
  return cloneBookSections(10 * 3600);
}

describe("a 10-hour book played at 1×", () => {
  it("never stalls after the first audio", () => {
    const report = simulateClonePlayback({
      sectionChars: tenHourSections(),
      batch: 24,
      env,
    });
    expect(report.stallCount).toBe(0);
    expect(report.steps[0]).toMatchObject({ shape: "cold", rows: 1, chars: MODAL_CLONE_OPENING_SECTION_CHARS });
    expect(report.steps[1]).toMatchObject({ rows: 1, chars: MODAL_CLONE_SECOND_CALL_CHARS });
    // 38s restore + 1,000 characters at 33 chars/s + the measured transfer.
    // Under the 75s first-light wait. The second call is the 1,300-character
    // row and leaves 23.3s. The tightest later margin is 17.0s. 1, 1, 12 is
    // the ramp; 10 is the rest of that 24-section claim; then full batches.
    // 1,424,500 ms is 23.7 minutes at the 15% curve. The smoke's own rates,
    // without that margin, are the ~20–21 minute projection.
    expect(report.timeToFirstAudioMs).toBe(68_576);
    expect(report.steps[0]!.wallMs).toBe(68_576);
    expect(report.steps[1]!.bufferAtDispatchMs - report.steps[1]!.wallMs).toBe(23_342);
    expect(report.minMarginMs).toBe(16_961);
    expect(report.totalWallMs).toBe(1_424_500);
    expect(report.sizeSequence).toEqual([
      1, 1, 12, 10, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 23,
    ]);
    for (const step of report.steps) {
      expect(step.wallMs).toBeLessThan(MODAL_CLONE_PROXY_KILL_MS);
      expect(estimateCloneBatchJsonBytes(step.chars)).toBeLessThanOrEqual(
        MODAL_CLONE_RESPONSE_BODY_MAX_BYTES
      );
      if (step.shape === "cold") expect(step.chars).toBeLessThanOrEqual(modalLaneCharCap(env));
    }
    expect(report.sizeSequence.reduce((sum, n) => sum + n, 0)).toBe(tenHourSections().length);
  });
});

describe("short pieces", () => {
  function opening(chars: number[], poolWarm = false) {
    return planModalCloneBookWave({
      pending: pending(chars.length),
      textAt: (index) => section(chars[index] ?? 0),
      firstLight: true,
      poolWarm,
      batch: 24,
      entireRemainder: true,
      env,
    });
  }

  it("sends the whole book when one call adds no generation beyond section 0", () => {
    // 1,000 + 959. Two rows at the smoke curve still finish in the opening
    // row's generation time. The only added wait is the extra body's transfer.
    const chars = [1_000, 959];
    const plan = opening(chars);
    const head = cloneCallWallMs({
      chars: 1_000,
      largestRow: 1_000,
      rows: 1,
      shape: "cold",
      restore: true,
    });
    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0]!.indexes).toEqual([0, 1]);
    expect(plan.deferred).toEqual([]);
    const transferDelta = cloneTransferMs(1_959) - cloneTransferMs(1_000);
    // Generation does not grow. The listener waits 262ms, which is the
    // transfer of the second section. 68,838 is still under the 75s
    // first-light wait, and ~69s.
    expect(head).toBe(68_576);
    expect(transferDelta).toBe(262);
    expect(plan.calls[0]!.wallMs).toBe(68_838);
    expect(plan.calls[0]!.wallMs).toBeLessThan(75_000);
    const ramp = planModalCloneBookWave({
      pending: pending(2),
      textAt: (index) => section(chars[index] ?? 0),
      firstLight: true,
      poolWarm: false,
      batch: 24,
      env,
    });
    const rampWall = ramp.calls.reduce((sum, call) => sum + call.wallMs, 0);
    expect(ramp.calls.length).toBeGreaterThan(1);
    expect(plan.calls[0]!.wallMs).toBeLessThan(rampWall);
    expect(plan.calls[0]!.wallMs).toBeLessThanOrEqual(head + 1_000);

    const warm = opening(chars, true);
    expect(warm.calls).toHaveLength(1);
    expect(warm.calls[0]!.wallMs).toBe(plan.calls[0]!.wallMs - 38_000);
  });

  it("ramps once a later row would make first audio later than section 0", () => {
    // 960 characters on the second row pushes the page past the opening's
    // generation time. A 1,300-character second section, and every article
    // that contains a 2,000-character row, does the same.
    const justOver = opening([1_000, 960]);
    expect(justOver.calls[0]!.indexes).toEqual([0]);
    expect(justOver.calls.length).toBeGreaterThan(1);

    const secondCall = opening([1_000, MODAL_CLONE_SECOND_CALL_CHARS]);
    expect(secondCall.calls[0]!.indexes).toEqual([0]);

    const fiveMinutes = opening(cloneBookSections(5 * 60));
    expect(fiveMinutes.calls[0]!.indexes).toEqual([0]);
    expect(fiveMinutes.calls[0]!.chars).toBe(MODAL_CLONE_OPENING_SECTION_CHARS);

    // A prefix of a longer book is not a short piece, even when those two
    // sections would have qualified on their own.
    const prefix = planModalCloneBookWave({
      pending: [0, 1],
      textAt: (index) => section(index === 0 ? 1_000 : 900),
      firstLight: true,
      poolWarm: false,
      batch: 24,
      env,
    });
    expect(prefix.calls[0]!.indexes).toEqual([0]);
  });

  it("gives an unstarted short book one call when the other listener can spare it", () => {
    const { active, waiting } = planTwoBooksOnOneGpu({
      active: {
        pending: [0, 1],
        textAt: (index) => section(index === 0 ? 1_000 : 900),
        firstLight: true,
        poolWarm: false,
      },
      waiting: {
        pending: pending(40),
        textAt: () => section(2_000),
        firstLight: false,
        poolWarm: true,
        playbackStarted: true,
        bufferedMs: 10 * 60_000,
      },
      batch: 24,
      env,
    });
    expect(active.calls).toHaveLength(1);
    expect(active.calls[0]!.indexes).toEqual([0, 1]);
    expect(waiting.calls).toEqual([]);
  });
});

describe("shorter books played at 1×", () => {
  function play(audioSeconds: number, poolWarm = false) {
    const sectionChars = cloneBookSections(audioSeconds);
    const report = simulateClonePlayback({
      sectionChars,
      batch: 24,
      poolWarm,
      env,
    });
    expect(report.stallCount).toBe(0);
    expect(report.steps[0]).toMatchObject({
      shape: "cold",
      rows: 1,
      chars: MODAL_CLONE_OPENING_SECTION_CHARS,
    });
    expect(report.sizeSequence.reduce((sum, n) => sum + n, 0)).toBe(sectionChars.length);
    expect(report.minMarginMs).toBeGreaterThanOrEqual(15_000);
    for (const step of report.steps) {
      expect(step.wallMs).toBeLessThan(MODAL_CLONE_PROXY_KILL_MS);
      expect(estimateCloneBatchJsonBytes(step.chars)).toBeLessThanOrEqual(
        MODAL_CLONE_RESPONSE_BODY_MAX_BYTES
      );
    }
    return report;
  }

  it("ramps a 5-minute, 10-minute, and 40-minute article and a 2-hour book", () => {
    // A 2,000-character row keeps these on the ramp. One batch would be
    // ~100s cold to first audio, against the opening's 68.6s.
    const five = play(5 * 60);
    expect(five.timeToFirstAudioMs).toBe(68_576);
    expect(five.sizeSequence).toEqual([1, 1, 2]);
    expect(five.minMarginMs).toBe(23_342);
    expect(five.totalWallMs).toBe(169_602);
    expect(cloneAudioMs(5 * 60 * MODAL_CLONE_CHARS_PER_AUDIO_SECOND)).toBe(300_000);

    const ten = play(10 * 60);
    expect(ten.timeToFirstAudioMs).toBe(68_576);
    expect(ten.sizeSequence).toEqual([1, 1, 4]);
    expect(ten.minMarginMs).toBe(23_342);
    expect(ten.totalWallMs).toBe(170_902);

    const forty = play(40 * 60);
    expect(forty.timeToFirstAudioMs).toBe(68_576);
    expect(forty.sizeSequence).toEqual([1, 1, 12, 6]);
    expect(forty.minMarginMs).toBe(16_961);
    expect(forty.totalWallMs).toBe(266_002);

    const twoHours = play(2 * 3600);
    expect(twoHours.timeToFirstAudioMs).toBe(68_576);
    expect(twoHours.sizeSequence).toEqual([1, 1, 12, 10, 24, 10]);
    expect(twoHours.minMarginMs).toBe(16_961);
    expect(twoHours.totalWallMs).toBe(463_370);
  });

  it("starts a 10-minute article on a warm pool without the restore", () => {
    const cold = play(10 * 60);
    const warm = play(10 * 60, true);
    expect(warm.timeToFirstAudioMs).toBe(30_576);
    expect(warm.timeToFirstAudioMs).toBe(cold.timeToFirstAudioMs - 38_000);
    expect(warm.sizeSequence).toEqual(cold.sizeSequence);
    expect(warm.minMarginMs).toBe(cold.minMarginMs);
    expect(warm.totalWallMs).toBe(132_902);
    expect(warm.totalWallMs).toBe(cold.totalWallMs - 38_000);
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
    expect(waiting.calls[0]!.wallMs).toBeLessThan(70_000);
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
    // One call at a time, so neither book has the single-book "rest of the
    // claim" step. Each listener's tightest margin is 17.0s. 2,799,158 ms
    // is both books.
    expect(reports[0]!.timeToFirstAudioMs).toBe(68_576);
    expect(reports[1]!.timeToFirstAudioMs).toBe(227_301);
    expect(reports[0]!.minMarginMs).toBe(16_961);
    expect(reports[1]!.minMarginMs).toBe(16_961);
    expect(totalWallMs).toBe(2_799_158);
    expect(reports[0]!.sizeSequence.reduce((sum, n) => sum + n, 0)).toBe(sections.length);
    expect(reports[1]!.sizeSequence.reduce((sum, n) => sum + n, 0)).toBe(sections.length);
    expect(reports[0]!.sizeSequence).toEqual([
      1, 1, 12, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 9,
    ]);
    expect(reports[1]!.sizeSequence).toEqual([
      1, 1, 12, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 9,
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
    const chars = tenHourSections();
    const result = await dispatchModalCloneLanes({
      indexes: pending(30),
      textAt: (index) => section(chars[index] ?? 2_000),
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
    expect(rows[1]).toEqual(["1"]);
    expect(render.mock.calls[1]![2]?.warmBatch).toBe(true);
    const widths = rows.map((keys) => keys.length);
    expect(widths[2]).toBeGreaterThan(1);
    expect(widths.some((width) => width > widths[2]!)).toBe(true);
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

  it("sends a short piece as one cold call", async () => {
    const render = vi.fn(async (items: { key: string }[]) =>
      outcome(items.map((item) => item.key))
    );
    const published: number[][] = [];
    const result = await dispatchModalCloneLanes({
      indexes: [0, 1],
      textAt: (index) => section(index === 0 ? 1_000 : 900),
      lanes: 4,
      batch: 24,
      maxLaneChars: 8_000,
      seedEpoch: 0,
      firstLight: true,
      bookWave: true,
      entireRemainder: true,
      poolWarm: false,
      render,
      stage: async () => {},
      publishStaged: async (indexes) => {
        published.push(indexes);
      },
    });
    expect(result.staged).toBe(2);
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0]![0].map((item: { key: string }) => item.key)).toEqual(["0", "1"]);
    expect(render.mock.calls[0]![2]?.warmBatch).toBe(false);
    expect(published).toEqual([[0, 1]]);
  });
});
