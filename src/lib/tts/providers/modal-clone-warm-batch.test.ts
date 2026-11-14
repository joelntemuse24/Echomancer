/**
 * In-book ramp for one restored H100.
 *
 * Section 0 is about a minute of audio. A 24-row call after it takes
 * several minutes and returns every row together, so the listener hears
 * that minute and then waits. Each next call is the largest prefix that
 * finishes, with margin, before the audio already buffered ahead of a
 * listener at 1.5× runs out. The prefix grows as that buffer grows.
 *
 * These tests pin the schedule without a GPU:
 *
 *   - the first call of a book stays one section that can survive a cold restore
 *   - the next call is not a full batch
 *   - a 10-hour book played at 1.5× never stalls after first audio
 *   - every call stays inside the Modal web-proxy budget and the 80 MiB body
 *   - a gap longer than scaledown drops back to one cold-sized call
 *   - two listeners on one GPU do not POST together; a turn is a ramp or
 *     a batch, not a one-row thrash, and both first audios stay under 5 min
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
  modalCloneNextSectionChars,
  modalCloneSecondCallChars,
  cloneAudioMs,
  cloneCallWallMs,
  cloneGenerationMs,
  clonePoolStillWarm,
  cloneRowCharsPerSecond,
  cloneTransferMs,
  cloneBatchHttpBytes,
  estimateCloneBatchJsonBytes,
  estimateCloneObjectBytes,
  modalLaneCharCap,
  modalWarmLaneCharLimit,
  chooseCloneGpuTurn,
  planMixedCloneBatch,
  planModalCloneBookWave,
  planTwoBooksOnOneGpu,
  simulateCloneFleet,
  simulateCloneListeners,
  simulateClonePlayback,
} from "@/lib/tts/providers/modal-clone-lanes";

const env = {} as NodeJS.ProcessEnv;
const section = (chars: number) => "x".repeat(chars);

function pending(n: number, from = 0): number[] {
  return Array.from({ length: n }, (_, i) => from + i);
}

describe("warm batch constants", () => {
  it("keeps the warm character cap under the documented full-batch band", () => {
    // 150 is the old pack floor. The page cap is batch × section width,
    // then the body and the wide-rate wait.
    expect(MODAL_LANE_WARM_CHARS_PER_SECOND).toBe(525);
    expect(MODAL_LANE_WARM_PACK_CHARS_PER_SECOND).toBe(150);
    expect(MODAL_CLONE_ROW_CHARS_PER_SECOND).toBe(44);
    expect(cloneRowCharsPerSecond(1)).toBeGreaterThan(40);
    expect(cloneRowCharsPerSecond(1)).toBeLessThan(50);
    // Wide calls share ~9× realtime, so each row's share falls as the call widens.
    expect(cloneRowCharsPerSecond(4) * 4).toBeGreaterThan(cloneRowCharsPerSecond(1) * 2);
    expect(cloneRowCharsPerSecond(24)).toBeLessThan(cloneRowCharsPerSecond(4));
  });

  it("plans 1-wide near 2.8× and wide batches near 9×", () => {
    const narrow = cloneCallWallMs({
      chars: 1_300,
      largestRow: 1_300,
      rows: 1,
      shape: "warm",
      restore: false,
    });
    const audio = (1_300 / MODAL_CLONE_CHARS_PER_AUDIO_SECOND) * 1000;
    // ~60 codec fps is about 2.8×. Publish and transfer sit on top of generation.
    expect(narrow).toBeGreaterThan(audio / 3.2);
    expect(narrow).toBeLessThan(audio / 2.2);
    const wide = cloneCallWallMs({
      chars: 8_000,
      largestRow: 2_000,
      rows: 4,
      shape: "warm",
      restore: false,
    });
    const wideAudio = (8_000 / MODAL_CLONE_CHARS_PER_AUDIO_SECOND) * 1000;
    expect(wide).toBeGreaterThan(wideAudio / 10);
    expect(wide).toBeLessThan(wideAudio / 7);
    expect(wide).toBeLessThan(MODAL_CLONE_PROXY_KILL_MS);
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
    expect(MODAL_CLONE_WARM_HOLD_DEFAULT_MS).toBe(10_000);
    expect(modalCloneWarmHoldMs(env)).toBe(10_000);
    expect(clonePoolStillWarm(10_000, 0, env)).toBe(true);
    expect(clonePoolStillWarm(10_001, 0, env)).toBe(false);
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

  it("ramps the first warm pages, then even slices of the rest", () => {
    const chars = tenHourSections();
    const plan = planModalCloneBookWave({
      pending: pending(60),
      textAt: (index) => section(chars[index] ?? 2_000),
      firstLight: true,
      poolWarm: false,
      batch: 24,
      env,
    });
    expect(plan.calls[0]!.indexes).toEqual([0]);
    expect(plan.calls[1]).toMatchObject({ shape: "warm", indexes: [1] });
    expect(plan.calls[2]).toMatchObject({ shape: "warm", indexes: [2] });
    const steady = plan.calls.slice(3);
    expect(steady.length).toBeGreaterThan(0);
    const widths = steady.map((call) => call.indexes.length);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(8);
    expect([...plan.calls.flatMap((call) => call.indexes), ...plan.deferred]).toEqual(
      pending(60)
    );
    for (const call of plan.calls) {
      expect(call.chars).toBeLessThanOrEqual(modalWarmLaneCharLimit(env));
      expect(call.waitMs).toBeLessThan(MODAL_CLONE_PROXY_KILL_MS);
      expect(call.wallMs).toBeLessThan(400_000);
      expect(estimateCloneBatchJsonBytes(call.chars)).toBeLessThanOrEqual(
        MODAL_CLONE_RESPONSE_BODY_MAX_BYTES
      );
    }
  });

  it("sends a later tick as one fat call once the buffer can cover it", () => {
    const plan = planModalCloneBookWave({
      pending: pending(24, 40),
      textAt,
      firstLight: false,
      poolWarm: true,
      batch: 24,
      playbackStarted: true,
      bufferedMs: 30 * 60_000,
      env,
    });
    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0]).toMatchObject({ shape: "warm" });
    expect(plan.calls[0]!.indexes).toEqual(pending(24, 40));
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
    // A full 24-row page is planned at the measured 528 chars/s. That
    // generation stays under the warm wait. 2,900 chars/s would have
    // scheduled a call this budget cannot survive.
    const smokeMs = (call.chars / 528) * 1000;
    expect(Math.abs(call.workMs - smokeMs)).toBeLessThan(2_000);
    expect(call.workMs).toBeLessThan(120_000);
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
      pending: pending(24, 40),
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
    // Inline audio stops near 59,000 characters (14 × 4,000 fits, 15 × 4,000
    // does not). Stored audio may carry a full batch of the widest section.
    expect(modalWarmLaneCharLimit(env)).toBeGreaterThanOrEqual(24 * 2_000);
    expect(modalWarmLaneCharLimit(env)).toBeGreaterThanOrEqual(14 * 4_000);
    expect(modalWarmLaneCharLimit(env)).toBeLessThan(15 * 4_000);
    expect(
      modalWarmLaneCharLimit({ MODAL_S2_AUDIO_TRANSPORT: "r2" } as NodeJS.ProcessEnv)
    ).toBeGreaterThanOrEqual(24 * 4_000);
    expect(estimateCloneBatchJsonBytes(24 * 4_000)).toBeGreaterThan(
      MODAL_CLONE_RESPONSE_BODY_MAX_BYTES
    );
  });
});

function cloneBookSections(audioSeconds: number): number[] {
  // The smoke's 15.85 characters per audio second. Each section is the
  // largest row that still leaves 15s at 1.5× after the sections before
  // it, and the steady width is 2,000 once that row fits.
  const totalChars = Math.round(audioSeconds * MODAL_CLONE_CHARS_PER_AUDIO_SECOND);
  const sections: number[] = [];
  let used = 0;
  while (used < totalChars) {
    const cap =
      sections.length === 0
        ? MODAL_CLONE_OPENING_SECTION_CHARS
        : modalCloneNextSectionChars(sections);
    const size = Math.min(Math.max(cap, 1), totalChars - used);
    sections.push(size);
    used += size;
  }
  return sections;
}

function tenHourSections(): number[] {
  return cloneBookSections(10 * 3600);
}

describe("a 10-hour book played at 1.5×", () => {
  it("sends a 9-section book in at most two batches after first light", () => {
    const sections = [1_000, ...Array.from({ length: 8 }, () => 1_350)];
    expect(sections.reduce((sum, chars) => sum + chars, 0)).toBe(11_800);
    const report = simulateClonePlayback({ sectionChars: sections, batch: 24, env });
    expect(report.steps[0]).toMatchObject({ shape: "cold", rows: 1 });
    const after = report.steps.slice(1);
    expect(after.length).toBeGreaterThan(0);
    expect(after.length).toBeLessThanOrEqual(2);
    expect(after.every((step) => step.rows > 1)).toBe(true);
    expect(after.reduce((sum, step) => sum + step.rows, 0)).toBe(8);
  });

  it("sends a long book to a full batch after the opening", () => {
    const sections = Array.from({ length: 80 }, (_, index) =>
      index === 0 ? 1_000 : 2_000
    );
    const report = simulateClonePlayback({ sectionChars: sections, batch: 24, env });
    expect(report.steps[0]).toMatchObject({ shape: "cold", rows: 1, chars: 1_000 });
    expect(report.steps[1]!.rows).toBe(1);
    expect(report.steps[2]!.rows).toBe(2);
    const steady = report.steps.slice(3);
    const widths = steady.map((step) => step.rows);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(8);
    for (const step of report.steps) {
      expect(step.wallMs).toBeLessThan(MODAL_CLONE_PROXY_KILL_MS);
    }
  });

  it("keeps first audio on one section, then full batches", () => {
    const report = simulateClonePlayback({
      sectionChars: tenHourSections(),
      batch: 24,
      env,
    });
    expect(report.steps[0]).toMatchObject({ shape: "cold", rows: 1, chars: MODAL_CLONE_OPENING_SECTION_CHARS });
    expect(report.steps[1]!.rows).toBe(1);
    expect(report.steps[2]!.rows).toBe(1);
    expect(report.steps[1]!.wallMs).toBeLessThan(400_000);
    expect(report.timeToFirstAudioMs).toBeLessThan(75_000);
    expect(report.steps[0]!.wallMs).toBe(report.timeToFirstAudioMs);
    expect(report.sizeSequence[0]).toBe(1);
    const steady = report.sizeSequence.slice(3);
    expect(Math.max(...steady) - Math.min(...steady)).toBeLessThanOrEqual(1);
    expect(report.sizeSequence.filter((n) => n === 1).length).toBe(3);
    expect(report.sizeSequence.some((n) => n >= 8)).toBe(true);
    for (const step of report.steps) {
      expect(step.wallMs).toBeLessThan(MODAL_CLONE_PROXY_KILL_MS);
      expect(estimateCloneBatchJsonBytes(step.chars)).toBeLessThanOrEqual(
        MODAL_CLONE_RESPONSE_BODY_MAX_BYTES
      );
      if (step.shape === "cold") expect(step.chars).toBeLessThanOrEqual(modalLaneCharCap(env));
    }
    expect(report.sizeSequence.reduce((sum, n) => sum + n, 0)).toBe(tenHourSections().length);
  });

  it("sends 24 rows of 4,000 once the container stores the MP3", () => {
    const r2 = { MODAL_S2_AUDIO_TRANSPORT: "r2" } as NodeJS.ProcessEnv;
    const report = simulateClonePlayback({
      sectionChars: tenHourSections(),
      batch: 24,
      env: r2,
    });
    expect(report.steps[0]).toMatchObject({ shape: "cold", rows: 1, chars: 1_000 });
    expect(report.steps[1]!.rows).toBe(1);
    expect(report.steps[2]!.rows).toBe(1);
    const page = report.steps.find((step) => step.rows === 24);
    expect(page?.chars).toBe(24 * 4_000);
    expect(page!.wallMs).toBeLessThan(400_000);
    expect(page!.wallMs).toBeLessThan(MODAL_CLONE_PROXY_KILL_MS);
    const steady = report.steps.slice(3).map((step) => step.rows);
    expect(Math.max(...steady) - Math.min(...steady)).toBeLessThanOrEqual(1);
    expect(cloneBatchHttpBytes(24 * 4_000, 24, r2)).toBeLessThan(
      MODAL_CLONE_RESPONSE_BODY_MAX_BYTES
    );
    expect(estimateCloneObjectBytes(24 * 4_000)).toBeGreaterThan(
      MODAL_CLONE_RESPONSE_BODY_MAX_BYTES
    );
    for (const step of report.steps) {
      expect(step.wallMs).toBeLessThan(400_000);
      expect(cloneBatchHttpBytes(step.chars, step.rows, r2)).toBeLessThanOrEqual(
        MODAL_CLONE_RESPONSE_BODY_MAX_BYTES
      );
    }
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
    // 1,000 + 700. Two rows still finish in the opening row's generation
    // time at the 1-wide floor. The only added wait is the extra transfer.
    const chars = [1_000, 700];
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
    const transferDelta = cloneTransferMs(1_700) - cloneTransferMs(1_000);
    expect(head).toBeLessThan(75_000);
    expect(transferDelta).toBeGreaterThan(0);
    expect(plan.calls[0]!.wallMs).toBeLessThan(75_000);
    // 959 is past the 1.5× row, so a ramp does not send it. A legal ramp
    // (section 0, then the 786-character row, then a steady row) is two
    // calls and takes longer than this one combined call.
    const ramp = planModalCloneBookWave({
      pending: pending(3),
      textAt: (index) =>
        section([1_000, modalCloneSecondCallChars(), 2_000][index] ?? 0),
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
    // generation time, and it is also past the 786-character row that
    // leaves 15s at 1.5×, so it is not sent until the outline is re-packed.
    const justOver = opening([1_000, 960]);
    expect(justOver.calls[0]!.indexes).toEqual([0]);
    expect(justOver.calls).toHaveLength(2);
    expect(justOver.calls[1]!.indexes).toEqual([1]);
    expect(justOver.deferred).toEqual([]);

    // A second section that does not add generation past section 0 is still
    // one call. 700 characters is inside that line at ~2.8× / ~9×; a longer
    // second section ramps so first audio stays the opening.
    const secondCall = opening([1_000, 700]);
    expect(secondCall.calls).toHaveLength(1);
    expect(secondCall.calls[0]!.indexes).toEqual([0, 1]);

    const fiveMinutes = opening(cloneBookSections(5 * 60));
    expect(fiveMinutes.calls[0]!.indexes).toEqual([0]);
    expect(fiveMinutes.calls[0]!.chars).toBe(MODAL_CLONE_OPENING_SECTION_CHARS);

    // A prefix of a longer book is not a short piece, even when those two
    // sections would have qualified on their own.
    const prefix = planModalCloneBookWave({
      pending: [0, 1],
      textAt: (index) => section(index === 0 ? 1_000 : 600),
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
        textAt: (index) => section(index === 0 ? 1_000 : 600),
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

describe("shorter books played at 1.5×", () => {
  function play(audioSeconds: number, poolWarm = false) {
    const sectionChars = cloneBookSections(audioSeconds);
    const report = simulateClonePlayback({
      sectionChars,
      batch: 24,
      poolWarm,
      env,
    });
    expect(report.steps[0]).toMatchObject({
      shape: "cold",
      rows: 1,
      chars: MODAL_CLONE_OPENING_SECTION_CHARS,
    });
    expect(report.sizeSequence.reduce((sum, n) => sum + n, 0)).toBe(sectionChars.length);
    expect(report.sizeSequence[0]).toBe(1);
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
    // ~100s cold to first audio, against the opening's 71.6s.
    const five = play(5 * 60);
    expect(five.timeToFirstAudioMs).toBeLessThan(75_000);
    expect(five.sizeSequence[0]).toBe(1);
    expect(five.sizeSequence.length).toBeLessThanOrEqual(3);
    expect(cloneAudioMs(5 * 60 * MODAL_CLONE_CHARS_PER_AUDIO_SECOND)).toBe(300_000);

    const ten = play(10 * 60);
    expect(ten.timeToFirstAudioMs).toBeLessThan(75_000);
    expect(ten.sizeSequence[0]).toBe(1);
    expect(ten.sizeSequence.length).toBeLessThanOrEqual(3);

    const forty = play(40 * 60);
    expect(forty.timeToFirstAudioMs).toBeLessThan(75_000);
    expect(forty.sizeSequence[0]).toBe(1);
    expect(forty.sizeSequence.length).toBeLessThanOrEqual(4);

    const twoHours = play(2 * 3600);
    expect(twoHours.timeToFirstAudioMs).toBeLessThan(75_000);
    expect(twoHours.sizeSequence[0]).toBe(1);
    expect(twoHours.sizeSequence.some((n) => n >= 8)).toBe(true);
  });

  it("starts a 10-minute article on a warm pool without the restore", () => {
    const cold = play(10 * 60);
    const warm = play(10 * 60, true);
    expect(warm.timeToFirstAudioMs).toBe(cold.timeToFirstAudioMs - 38_000);
    expect(warm.sizeSequence).toEqual(cold.sizeSequence);
    expect(warm.minMarginMs).toBe(cold.minMarginMs);
    expect(warm.minMarginAt15xMs).toBe(cold.minMarginAt15xMs);
    expect(warm.totalWallMs).toBe(cold.totalWallMs - 38_000);
  });
});

describe("overflow scheduler, one GPU", () => {
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

  it("keeps two 10-hour books on wide calls and finishes near twice one book", () => {
    const sections = tenHourSections();
    const single = simulateClonePlayback({ sectionChars: sections, batch: 24, env });
    const { reports, totalWallMs, overlapping } = simulateCloneListeners({
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
      expect(report.sizeSequence[0]).toBe(1);
      expect(report.timeToFirstAudioMs).toBeGreaterThan(0);
      expect(report.timeToFirstAudioMs).toBeLessThan(5 * 60_000);
      expect(report.sizeSequence.reduce((sum, n) => sum + n, 0)).toBe(sections.length);
      expect(report.steps.every((step) => step.wallMs < MODAL_CLONE_PROXY_KILL_MS)).toBe(true);
      expect(report.sizeSequence.some((n) => n >= 8)).toBe(true);
      // The old schedule was one row per call after the opening and took
      // 36,439,973 ms. A book of single rows cannot feed two 1.5× listeners.
      expect(report.sizeSequence.filter((n) => n === 1).length).toBeLessThan(8);
    }
    expect(single.timeToFirstAudioMs).toBeLessThan(75_000);
    expect(reports[0]!.timeToFirstAudioMs).toBe(single.timeToFirstAudioMs);
    expect(reports[0]!.sizeSequence.some((n) => n >= 8)).toBe(true);
    expect(reports[1]!.sizeSequence.some((n) => n >= 8)).toBe(true);
    expect(totalWallMs).toBeLessThan(single.totalWallMs * 2 + 180_000);
    expect(totalWallMs).toBeLessThan(36_439_973);
  });

  it("plays three 10-hour books and a late article without collapsing to one-row calls", () => {
    const ten = tenHourSections();
    const article = cloneBookSections(40 * 60);
    const three = simulateCloneListeners({
      books: [
        { id: "a", sectionChars: ten },
        { id: "b", sectionChars: ten },
        { id: "c", sectionChars: ten },
      ],
      batch: 24,
      env,
    });
    const late = simulateCloneListeners({
      books: [
        { id: "book", sectionChars: ten },
        { id: "article", sectionChars: article, startAtMs: 5 * 60_000 },
      ],
      batch: 24,
      env,
    });
    const single = simulateClonePlayback({ sectionChars: ten, batch: 24, env });
    // Three books share one GPU, so turns interleave and some calls are
    // narrower than a solo 14-row page. That is slower than three solos
    // placed end to end. It is not the old one-row schedule.
    expect(three.totalWallMs).toBeLessThan(single.totalWallMs * 3 + 1_200_000);
    expect(three.reports[0]!.timeToFirstAudioMs).toBe(single.timeToFirstAudioMs);
    expect(three.reports.every((report) => report.sizeSequence.some((n) => n >= 8))).toBe(true);
    expect(late.reports[0]!.timeToFirstAudioMs).toBe(single.timeToFirstAudioMs);
    expect(late.reports[1]!.timeToFirstAudioMs).toBeGreaterThan(5 * 60_000);
    expect(late.totalWallMs).toBeLessThan(single.totalWallMs * 2);
  });

  it("posts two and three 10-hour books through dispatch without the one-row total", async () => {
    async function replay(bookCount: number) {
      const sections = tenHourSections();
      const posted: number[][] = [];
      const render = vi.fn(async (items: { key: string }[]) => {
        posted.push(items.map((item) => Number(item.key)));
        const audio = new Map<string, { audio: Buffer; durationSeconds: number }>();
        for (const item of items) {
          audio.set(item.key, { audio: Buffer.from("mp3"), durationSeconds: 12 });
        }
        return {
          audio,
          build: "abc",
          containerId: "gpu-1",
          seed: 1,
          performance: { generate_s: 4 },
          boot: "restored" as const,
        };
      });
      const states = Array.from({ length: bookCount }, (_, id) => ({
        id: String.fromCharCode(97 + id),
        chars: sections,
        next: 0,
        started: false,
        wall: 0,
      }));
      let poolWarm = false;
      let clock = 0;
      let guard = 0;
      const cap = sections.length * bookCount + 5;
      while (states.some((book) => book.next < book.chars.length) && guard < cap) {
        guard += 1;
        const turn = chooseCloneGpuTurn({
          books: states
            .filter((book) => book.next < book.chars.length)
            .map((book) => ({
              id: book.id,
              pending: book.chars.slice(book.next).map((_, offset) => book.next + offset),
              textAt: (index) => section(book.chars[index] ?? 0),
              playbackStarted: book.started,
              bufferedMs: book.started ? book.wall : 0,
              firstLight: book.next === 0,
            })),
          poolWarm,
          batch: 24,
          env,
        });
        expect(turn.call).toBeTruthy();
        const book = states.find((item) => item.id === turn.bookId)!;
        const before = posted.length;
        await dispatchModalCloneLanes({
          indexes: turn.call!.indexes,
          textAt: (index) => section(book.chars[index] ?? 0),
          lanes: 1,
          batch: 24,
          maxLaneChars: 8_000,
          seedEpoch: 0,
          firstLight: !book.started && turn.call!.indexes[0] === 0,
          bookWave: true,
          poolWarm,
          playbackStarted: book.started,
          bufferedMs: book.started ? book.wall : 0,
          maxCalls: 1,
          committedCall: true,
          render,
          stage: async () => {},
        });
        expect(posted.length).toBe(before + 1);
        expect(posted.at(-1)).toEqual(turn.call!.indexes);
        const spent = turn.call!.wallMs;
        for (const other of states) {
          if (!other.started || other.id === book.id) continue;
          other.wall = Math.max(0, other.wall - spent);
        }
        if (!book.started) {
          book.started = true;
          book.wall = Math.floor(turn.call!.audioMs / 1.5);
        } else {
          book.wall = Math.max(0, book.wall - spent) + Math.floor(turn.call!.audioMs / 1.5);
        }
        book.next += turn.call!.indexes.length;
        clock += spent;
        poolWarm = true;
      }
      return { posted, clock, sections: sections.length };
    }

    const two = await replay(2);
    // The one-row schedule posted 36,439,973 ms. A wide ramp stays under that.
    expect(two.clock).toBeLessThan(36_439_973);
    expect(two.posted.flat()).toHaveLength(two.sections * 2);
    expect(two.posted.some((call) => call.length >= 8)).toBe(true);
    expect(two.posted.filter((call) => call.length === 1).length).toBeLessThan(8);

    const three = await replay(3);
    expect(three.clock).toBeLessThan(36_439_973);
    expect(three.posted.flat()).toHaveLength(three.sections * 3);
    expect(three.posted.some((call) => call.length >= 8)).toBe(true);
    expect(three.posted.filter((call) => call.length === 1).length).toBeLessThan(12);
  });

  it("packs both books into one call only as a redeploy payload", () => {
    const rows = planMixedCloneBatch({
      books: [
        {
          id: "a",
          pending: [0, 1],
          textAt: () => section(100),
          referenceAudioBase64: "aaa",
          referenceText: "voice a",
          seedFor: (index) => index + 1,
        },
        {
          id: "b",
          pending: [0, 1],
          textAt: () => section(100),
          referenceAudioBase64: "bbb",
          referenceText: "voice b",
          seedFor: (index) => 10 + index,
        },
      ],
      batch: 24,
      env,
    });
    expect(rows.map((row) => row.bookId)).toEqual(["a", "b", "a", "b"]);
    expect(new Set(rows.map((row) => row.referenceAudioBase64))).toEqual(new Set(["aaa", "bbb"]));
    expect(rows[0]!.seed).toBe(1);
    expect(rows[1]!.seed).toBe(10);
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
      indexes: pending(29),
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
    expect(result.staged).toBe(29);
    const rows = render.mock.calls.map((call) => call[0].map((item: { key: string }) => item.key));
    expect(rows[0]).toEqual(["0"]);
    expect(render.mock.calls[0]![2]?.warmBatch).toBe(false);
    expect(rows[3]!.length).toBeGreaterThan(1);
    expect(render.mock.calls[1]![2]?.warmBatch).toBe(true);
    const widths = rows.map((keys) => keys.length);
    expect(widths).toEqual([1, 1, 1, 13, 13]);
    expect(widths.filter((width) => width === 1).length).toBe(3);
    expect(widths.reduce((sum, n) => sum + n, 0)).toBe(29);
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
      textAt: (index) => section(index === 0 ? 1_000 : 600),
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

describe("one H100 per book", () => {
  function books(count: number, user: (index: number) => string) {
    const sections = tenHourSections();
    return Array.from({ length: count }, (_, index) => ({
      id: `book-${index}`,
      userId: user(index),
      sectionChars: sections,
      createdAt: index + 1,
    }));
  }

  it("keeps every book on the single-book ramp while GPUs remain", () => {
    const one = simulateCloneFleet({ books: books(1, () => "u0"), env });
    expect(one.peakGpus).toBe(1);
    expect(one.reports[0]!.mode).toBe("solo");
    expect(one.reports[0]!.timeToFirstAudioMs).toBeLessThan(75_000);

    for (const count of [2, 3, 10]) {
      const fleet = simulateCloneFleet({
        books: books(count, (index) => `user-${index}`),
        env,
      });
      expect(fleet.peakGpus).toBe(count);
      expect(fleet.totalWallMs).toBe(one.totalWallMs);
      for (const report of fleet.reports) {
        expect(report.mode).toBe("solo");
        expect(report.timeToFirstAudioMs).toBe(one.reports[0]!.timeToFirstAudioMs);
        expect(report.minMarginAt15xMs).toBe(one.reports[0]!.minMarginAt15xMs);
        expect(report.finishedAtMs).toBe(one.totalWallMs);
      }
    }

    const sameUser = simulateCloneFleet({
      books: books(3, () => "one-user"),
      env,
    });
    expect(sameUser.peakGpus).toBe(3);
    expect(sameUser.totalWallMs).toBe(one.totalWallMs);
    expect(sameUser.reports.every((report) => report.minMarginAt15xMs === one.reports[0]!.minMarginAt15xMs)).toBe(true);
  });

  it("gives a late article its own GPU", () => {
    const fleet = simulateCloneFleet({
      books: [
        {
          id: "book",
          userId: "reader",
          sectionChars: tenHourSections(),
          createdAt: 1,
        },
        {
          id: "article",
          userId: "reader",
          sectionChars: cloneBookSections(40 * 60),
          startAtMs: 5 * 60_000,
          createdAt: 2,
        },
      ],
      env,
    });
    const book = fleet.reports.find((report) => report.id === "book")!;
    const article = fleet.reports.find((report) => report.id === "article")!;
    const articleAlone = simulateClonePlayback({
      sectionChars: cloneBookSections(40 * 60),
      batch: 24,
      env,
    });
    expect(fleet.peakGpus).toBe(2);
    expect(book.mode).toBe("solo");
    expect(book.timeToFirstAudioMs).toBeLessThan(75_000);
    expect(book.finishedAtMs).toBe(fleet.reports.find((report) => report.id === "book")!.finishedAtMs);
    expect(article.mode).toBe("solo");
    expect(article.timeToFirstAudioMs).toBe(5 * 60_000 + articleAlone.timeToFirstAudioMs);
    expect(article.minMarginAt1xMs).toBe(articleAlone.minMarginAt1xMs);
    expect(article.minMarginAt15xMs).toBe(articleAlone.minMarginAt15xMs);
    expect(article.finishedAtMs).toBe(5 * 60_000 + articleAlone.totalWallMs);
    expect(fleet.totalWallMs).toBe(book.finishedAtMs);
  });

  it("shares only the book that does not fit, and a sixth same-user book", () => {
    const over = simulateCloneFleet({
      books: books(3, (index) => `user-${index}`),
      globalCap: 2,
      perUserCap: 5,
      env,
    });
    expect(over.peakGpus).toBe(2);
    const host = over.reports.find((report) => report.mode === "host")!;
    const guest = over.reports.find((report) => report.mode === "guest")!;
    const spared = over.reports.find((report) => report.mode === "solo")!;
    expect(spared.timeToFirstAudioMs).toBeLessThan(75_000);
    expect(host.timeToFirstAudioMs).toBe(spared.timeToFirstAudioMs);
    expect(guest.timeToFirstAudioMs).toBeGreaterThan(host.timeToFirstAudioMs);
    expect(over.totalWallMs).toBeGreaterThan(spared.finishedAtMs);
    // The shared pair is the overflow scheduler, not the one-row collapse.
    expect(host.sizeSequence.some((rows) => rows >= 8)).toBe(true);
    expect(guest.sizeSequence.some((rows) => rows >= 8)).toBe(true);
    expect(over.totalWallMs).toBeLessThan(36_439_973);

    const sixth = simulateCloneFleet({
      books: books(6, () => "same"),
      globalCap: 20,
      perUserCap: 5,
      env,
    });
    expect(sixth.peakGpus).toBe(5);
    expect(sixth.reports.filter((report) => report.mode === "solo")).toHaveLength(4);
    expect(sixth.reports.filter((report) => report.mode === "host")).toHaveLength(1);
    expect(sixth.reports.filter((report) => report.mode === "guest")).toHaveLength(1);
    const sharedHost = sixth.reports.find((report) => report.mode === "host")!;
    const sharedGuest = sixth.reports.find((report) => report.mode === "guest")!;
    expect(sharedHost.id).toBe("book-0");
    expect(sharedGuest.id).toBe("book-5");
    expect(sixth.totalWallMs).toBeGreaterThan(spared.finishedAtMs);
    for (const report of sixth.reports.filter((item) => item.mode === "solo")) {
      expect(report.finishedAtMs).toBe(spared.finishedAtMs);
    }
  });
});

describe("a book wave does not fan out", () => {
  it("keeps one call in flight when lanes is 8", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const render = vi.fn(async (items: { key: string }[]) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      const audio = new Map<string, { audio: Buffer; durationSeconds: number }>();
      for (const item of items) {
        audio.set(item.key, { audio: Buffer.from("mp3"), durationSeconds: 12 });
      }
      return {
        audio,
        build: "abc",
        containerId: "gpu-1",
        seed: 1,
        performance: { generate_s: 4 },
        boot: "restored" as const,
      };
    });
    const indexes = Array.from({ length: 24 }, (_, index) => index);
    await dispatchModalCloneLanes({
      indexes,
      textAt: () => section(2_000),
      lanes: 8,
      batch: 3,
      maxLaneChars: Number.POSITIVE_INFINITY,
      seedEpoch: 0,
      bookWave: true,
      committedCall: true,
      maxCalls: 1,
      playbackStarted: true,
      bufferedMs: 60 * 60_000,
      poolWarm: true,
      render,
      stage: async () => {},
    });
    expect(render).toHaveBeenCalledTimes(1);
    expect(maxInFlight).toBe(1);
    expect(render.mock.calls[0]![0]).toHaveLength(3);
  });
});
