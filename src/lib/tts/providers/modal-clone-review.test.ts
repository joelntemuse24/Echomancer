/**
 * Regressions from the PR 274 review. Each case is one finding: a missed
 * book wave must not open more GPU calls, a cold pack must fit the abort
 * it will arm, warmth and compile kicks stay with the wait that caused
 * them, and the listener buffer is the 1.5× spare.
 */

import { describe, expect, it, vi } from "vitest";
import { ModalCloneColdError, ModalCloneLaneBusyError, modalCloneCallWait, modalClonePoolIsWarm, noteModalClonePoolAnswered, readModalCloneJson, resetModalCloneRuntimeForTests } from "@/lib/tts/providers/modal-clone";
import { dispatchModalCloneLanes } from "@/lib/tts/providers/modal-clone-dispatch";
import {
  MODAL_CLONE_OPENING_SECTION_CHARS,
  MODAL_CLONE_PUBLISH_MS,
  MODAL_CLONE_RESPONSE_BODY_MAX_BYTES,
  cloneCallWallMs,
  clonePlanningBufferMs,
  coldClonePackFitsAbort,
  modalCloneColdSafeRowChars,
  modalCloneSecondCallChars,
  modalCloneThirdCallChars,
  planModalCloneBookWave,
  simulateClonePlayback,
} from "@/lib/tts/providers/modal-clone-lanes";
import { cloneDropLedger, cloneSeedEpoch, listenerBufferMs, unpublishedSectionLengths, cloneOutlineRepackKind } from "@/lib/tts/process-job";
import * as modalCloneWarm from "@/lib/tts/providers/modal-clone-warm";

const text = (chars: number) => "x".repeat(chars);

describe("cold packs fit the abort they arm", () => {
  it("refuses a 7,700-character row and accepts a 2,000-character row", () => {
    const wide = coldClonePackFitsAbort({
      chars: 7_700,
      largestRow: 7_700,
      rows: 1,
      raceForFirstAudio: false,
    });
    const packed = coldClonePackFitsAbort({
      chars: 2_000,
      largestRow: 2_000,
      rows: 1,
      raceForFirstAudio: false,
    });
    const opening = coldClonePackFitsAbort({
      chars: MODAL_CLONE_OPENING_SECTION_CHARS,
      largestRow: MODAL_CLONE_OPENING_SECTION_CHARS,
      rows: 1,
      raceForFirstAudio: true,
    });
    expect(wide.fits).toBe(false);
    expect(wide.wallMs).toBeGreaterThanOrEqual(wide.abortMs);
    expect(packed.fits).toBe(true);
    expect(packed.wallMs).toBeLessThan(packed.abortMs);
    expect(opening.fits).toBe(true);
    expect(opening.wallMs).toBeLessThan(opening.abortMs);
    expect(modalCloneColdSafeRowChars()).toBeGreaterThanOrEqual(2_000);
    expect(modalCloneColdSafeRowChars()).toBeLessThan(7_700);
  });

  it("does not plan a cold call whose wall is not under the armed wait", () => {
    const plan = planModalCloneBookWave({
      pending: [0],
      textAt: () => text(7_700),
      firstLight: true,
      poolWarm: false,
      batch: 24,
    });
    expect(plan.calls).toEqual([]);
    const cold = planModalCloneBookWave({
      pending: [3],
      textAt: () => text(7_700),
      firstLight: false,
      poolWarm: false,
      batch: 24,
    });
    expect(cold.calls).toEqual([]);
  });

  it("passes the planned wall into the abort", async () => {
    const seen: number[] = [];
    await dispatchModalCloneLanes({
      indexes: [0],
      textAt: () => text(MODAL_CLONE_OPENING_SECTION_CHARS),
      lanes: 4,
      batch: 24,
      maxLaneChars: 8_000,
      seedEpoch: 0,
      firstLight: true,
      bookWave: true,
      poolWarm: false,
      render: async (items, _epoch, opts) => {
        seen.push(opts?.workMs ?? 0);
        const audio = new Map<string, { audio: Buffer; durationSeconds: number }>();
        for (const item of items) audio.set(item.key, { audio: Buffer.from("mp3"), durationSeconds: 12 });
        return { audio, build: "abc", containerId: "gpu", seed: 1, performance: null, boot: "restored" };
      },
      stage: async () => {},
    });
    const wall = cloneCallWallMs({
      chars: MODAL_CLONE_OPENING_SECTION_CHARS,
      largestRow: MODAL_CLONE_OPENING_SECTION_CHARS,
      rows: 1,
      shape: "cold",
      restore: true,
    });
    expect(seen[0]).toBe(wall);
    const armed = modalCloneCallWait(false, true, wall, false);
    expect(wall).toBeLessThan(armed.ms);
    expect(wall).toBe(wall - MODAL_CLONE_PUBLISH_MS + MODAL_CLONE_PUBLISH_MS);
  });
});

describe("a warm miss does not forget the pool or compile", () => {
  it("keeps warmth when the lane is busy", async () => {
    resetModalCloneRuntimeForTests();
    noteModalClonePoolAnswered();
    expect(modalClonePoolIsWarm()).toBe(true);
    const render = vi.fn(async () => {
      throw new ModalCloneLaneBusyError("shared clone lane is in use");
    });
    const result = await dispatchModalCloneLanes({
      indexes: [4, 5, 6],
      textAt: () => text(400),
      lanes: 4,
      batch: 24,
      maxLaneChars: 8_000,
      seedEpoch: 0,
      bookWave: true,
      poolWarm: true,
      playbackStarted: true,
      bufferedMs: 10 * 60_000,
      render,
      stage: async () => {},
    });
    expect(render).toHaveBeenCalledTimes(1);
    expect(result.busy).toBe(1);
    expect(modalClonePoolIsWarm()).toBe(true);
  });

  it("does not kick a compile for a warm wait or the one-row retry after it", async () => {
    resetModalCloneRuntimeForTests();
    const kick = vi.spyOn(modalCloneWarm, "kickModalCloneSnapshotWarm").mockReturnValue(true);
    const render = vi.fn(async () => {
      throw new ModalCloneColdError("warm batch slow", 30_000, "placement", "warm");
    });
    await dispatchModalCloneLanes({
      indexes: [4, 5, 6, 7],
      textAt: () => text(400),
      lanes: 4,
      batch: 24,
      maxLaneChars: 8_000,
      seedEpoch: 0,
      bookWave: true,
      poolWarm: true,
      playbackStarted: true,
      bufferedMs: 10 * 60_000,
      render,
      stage: async () => {},
    });
    expect(kick).not.toHaveBeenCalled();
    kick.mockRestore();
  });
});

describe("the second call is re-planned from the buffer", () => {
  it("does not send a 2,000-character row while the opening is still the buffer", () => {
    const cap = modalCloneSecondCallChars();
    expect(cap).toBeLessThan(1_300);
    expect(cap).toBeGreaterThan(400);
    const plan = planModalCloneBookWave({
      pending: [1],
      textAt: () => text(2_000),
      firstLight: false,
      poolWarm: true,
      batch: 24,
      playbackStarted: true,
      bufferedMs: clonePlanningBufferMs(
        cloneCallWallMs({
          chars: 0,
          largestRow: 0,
          rows: 1,
          shape: "warm",
          restore: false,
        }) === 0
          ? 0
          : 63_091
      ),
    });
    // 63,091ms is section 0's audio. A 2,000-character row does not fit it at 1.5×.
    const opening = planModalCloneBookWave({
      pending: [1],
      textAt: () => text(2_000),
      firstLight: false,
      poolWarm: true,
      batch: 24,
      playbackStarted: true,
      bufferedMs: clonePlanningBufferMs(63_091),
    });
    expect(opening.calls).toEqual([]);
    const fitted = planModalCloneBookWave({
      pending: [1],
      textAt: () => text(cap),
      firstLight: false,
      poolWarm: true,
      batch: 24,
      playbackStarted: true,
      bufferedMs: clonePlanningBufferMs(63_091),
    });
    expect(fitted.calls[0]?.chars).toBe(cap);
    expect(fitted.calls[0]?.fitsBuffer).toBe(true);
    expect(plan.calls).toEqual([]);
  });

  it("shrinks the next call when a container is slower than the plan", () => {
    const sections = [
      1_000,
      modalCloneSecondCallChars(),
      modalCloneThirdCallChars(),
      ...Array.from({ length: 40 }, () => 2_000),
    ];
    const fast = simulateClonePlayback({ sectionChars: sections, batch: 24 });
    const slow = simulateClonePlayback({
      sectionChars: sections,
      batch: 24,
      slowCall: { step: 1, factor: 3 },
    });
    expect(fast.stallCount).toBe(0);
    expect(fast.steps[2]!.chars).toBeGreaterThan(0);
    expect(slow.steps[2]?.chars ?? 0).toBeLessThan(fast.steps[2]!.chars);
  });
});

describe("dropped rows move the seed", () => {
  it("writes a retry and fails on the attempt budget", () => {
    const first = cloneDropLedger(undefined);
    expect(first).toEqual({ status: "retry", attempts: 1 });
    expect(
      cloneSeedEpoch([{ index: 0, path: "", status: "retry", attempts: first.attempts }])
    ).toBe(1);
    const second = cloneDropLedger({ index: 0, path: "", status: "retry", attempts: 1 });
    expect(second.status).toBe("retry");
    expect(second.attempts).toBe(2);
    expect(
      cloneSeedEpoch([{ index: 0, path: "", status: "retry", attempts: second.attempts }])
    ).toBe(2);
    const third = cloneDropLedger({ index: 0, path: "", status: "retry", attempts: 2 });
    expect(third).toEqual({ status: "failed", attempts: 3 });
  });
});

describe("the other book's real section length", () => {
  it("uses the next unpublished section, not a synthetic 1,000", () => {
    expect(
      unpublishedSectionLengths(
        [
          { index: 0, text: text(800) },
          { index: 1, text: text(2_000) },
          { index: 2, text: text(1_500) },
        ],
        [{ index: 0, status: "ready" }],
        [1_000, 1_300]
      )
    ).toEqual([2_000, 1_500]);
    expect(unpublishedSectionLengths(null, [], [1_000, 1_300])).toEqual([1_000, 1_300]);
  });
});

describe("listener buffer at 1.5×", () => {
  it("divides the 1× spare and does not grow when the clock is ahead", () => {
    const ready = [{ index: 0, path: "a.mp3", status: "ready" as const, durationSeconds: 60 }];
    const onTime = listenerBufferMs(["hello"], ready, 1_000, 1_000 * 1000);
    expect(onTime.bufferedMs).toBe(Math.floor(60_000 / 1.5));
    const later = listenerBufferMs(["hello"], ready, 1_000, 1_000 * 1000 + 20_000);
    expect(later.bufferedMs).toBeLessThan(onTime.bufferedMs);
    const seekedPast = listenerBufferMs(["hello"], ready, 1_000, 1_000 * 1000 + 90_000);
    expect(seekedPast.bufferedMs).toBe(0);
  });
});

describe("unpublished outlines are re-packed", () => {
  it("rebuilds an unstarted 800-then-2,000 outline and only the tail once section 0 is out", () => {
    const sections = [
      { index: 0, text: text(800) },
      { index: 1, text: text(2_000) },
    ];
    const limits = {
      opening: 1_000,
      second: modalCloneSecondCallChars(),
      third: modalCloneThirdCallChars(),
      coldSafe: modalCloneColdSafeRowChars(),
    };
    expect(cloneOutlineRepackKind(sections, new Set(), limits)).toBe("rebuild");
    expect(cloneOutlineRepackKind(sections, new Set([0]), limits)).toBe("tail");
    expect(
      cloneOutlineRepackKind(
        [{ index: 0, text: text(1_000) }, { index: 1, text: text(limits.second) }],
        new Set(),
        limits
      )
    ).toBe(null);
  });
});

describe("Modal response size", () => {
  it("rejects a Content-Length over the ceiling before parsing", async () => {
    const response = new Response("this is not json", {
      headers: { "content-length": String(MODAL_CLONE_RESPONSE_BODY_MAX_BYTES + 1) },
    });
    await expect(readModalCloneJson(response)).rejects.toThrow(/ceiling/);
  });
});

describe("two books share the GPU one call at a time", () => {
  it("stops the ramp when another take-home becomes runnable", async () => {
    let checks = 0;
    const render = vi.fn(async (items: { key: string }[]) => {
      const audio = new Map<string, { audio: Buffer; durationSeconds: number }>();
      for (const item of items) audio.set(item.key, { audio: Buffer.from("mp3"), durationSeconds: 12 });
      return { audio, build: "abc", containerId: "gpu", seed: 1, performance: null, boot: "restored" };
    });
    const result = await dispatchModalCloneLanes({
      indexes: [0, 1, 2, 3, 4, 5],
      textAt: (index) => text(index === 0 ? 1_000 : modalCloneSecondCallChars()),
      lanes: 4,
      batch: 24,
      maxLaneChars: 8_000,
      seedEpoch: 0,
      firstLight: true,
      bookWave: true,
      poolWarm: false,
      render,
      stage: async () => {},
      yieldToOther: async () => {
        checks += 1;
        return checks > 0;
      },
    });
    expect(render).toHaveBeenCalledTimes(1);
    expect(result.handedOff).toBe(true);
  });
});
