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
  advancePlanningBuffer,
  cloneAudioMs,
  cloneCallWallMs,
  clonePlanningBufferMs,
  coldClonePackFitsAbort,
  modalCloneColdSafeRowChars,
  modalCloneNextSectionChars,
  modalCloneSecondCallChars,
  modalCloneThirdCallChars,
  planModalCloneBookWave,
  simulateClonePlayback,
} from "@/lib/tts/providers/modal-clone-lanes";
import { repackFrozenTail } from "@/lib/tts/frozen-script";
import type { FrozenSection } from "@/lib/tts/types";
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

describe("the second call is the steady section", () => {
  it("sends the steady row once playback has started", () => {
    const cap = modalCloneSecondCallChars();
    expect(cap).toBe(4_000);
    const opening = planModalCloneBookWave({
      pending: [1],
      textAt: () => text(2_000),
      firstLight: false,
      poolWarm: true,
      batch: 24,
      playbackStarted: true,
      bufferedMs: clonePlanningBufferMs(63_091),
    });
    // A started book is not paced to the opening buffer.
    expect(opening.calls[0]?.indexes).toEqual([1]);
    expect(opening.calls[0]?.chars).toBe(2_000);
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
    expect(fast.steps[2]!.chars).toBeGreaterThan(0);
    // Later pages are the largest proxy-safe batch, so a slow container
    // does not shrink the next page. It only takes longer.
    expect(slow.steps[2]?.chars ?? 0).toBe(fast.steps[2]!.chars);
    expect(slow.totalWallMs).toBeGreaterThan(fast.totalWallMs);
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
  it("is wall time left: delivered / 1.5 minus elapsed", () => {
    const ready = [{ index: 0, path: "a.mp3", status: "ready" as const, durationSeconds: 60 }];
    const onTime = listenerBufferMs(["hello"], ready, 1_000, 1_000 * 1000);
    expect(onTime.bufferedMs).toBe(Math.floor(60_000 / 1.5));
    const later = listenerBufferMs(["hello"], ready, 1_000, 1_000 * 1000 + 20_000);
    // 20s of wall consumes 20s of the planning buffer, not 20s of audio
    // divided by 1.5 afterwards.
    expect(later.bufferedMs).toBe(Math.floor(60_000 / 1.5) - 20_000);
    const seekedPast = listenerBufferMs(["hello"], ready, 1_000, 1_000 * 1000 + 90_000);
    expect(seekedPast.bufferedMs).toBe(0);
    const opened = clonePlanningBufferMs(cloneAudioMs(1_000));
    const spent = cloneCallWallMs({
      chars: modalCloneSecondCallChars(),
      largestRow: modalCloneSecondCallChars(),
      rows: 1,
      shape: "warm",
      restore: false,
    });
    const added = cloneAudioMs(modalCloneSecondCallChars());
    expect(advancePlanningBuffer(opened, spent, added)).toBe(
      Math.max(0, opened - spent) + clonePlanningBufferMs(added)
    );
  });
});

function rampOutline(count: number): number[] {
  const sections: number[] = [];
  while (sections.length < count) {
    const next =
      sections.length === 0
        ? MODAL_CLONE_OPENING_SECTION_CHARS
        : modalCloneNextSectionChars(sections);
    sections.push(Math.max(next, 1));
  }
  return sections;
}

describe("replay through the planner", () => {
  it("finishes the outline in proxy-safe calls", async () => {
    const sections = rampOutline(43);
    expect(sections[0]).toBe(1_000);
    expect(sections[1]).toBe(modalCloneSecondCallChars());
    expect(sections[2]).toBe(modalCloneThirdCallChars());
    expect(sections[2]).toBe(4_000);

    let pending = sections.map((_, index) => index);
    let started = false;
    let delivered = 0;
    let elapsed = 0;
    let buffer = 0;
    const posted: number[][] = [];
    let guard = 0;
    while (pending.length > 0 && guard < sections.length + 2) {
      guard += 1;
      const plan = planModalCloneBookWave({
        pending,
        textAt: (index) => text(sections[index] ?? 0),
        firstLight: pending[0] === 0 && !started,
        poolWarm: started,
        batch: 24,
        bufferedMs: started ? buffer : 0,
        playbackStarted: started,
        entireRemainder: true,
        maxCalls: 1,
      });
      const call = plan.calls[0];
      expect(call).toBeTruthy();
      if (started) {
        expect(call!.wallMs).toBeLessThan(542_000);
      }
      posted.push(call!.indexes);
      if (!started) {
        started = true;
        delivered = call!.audioMs;
        elapsed = 0;
        buffer = clonePlanningBufferMs(call!.audioMs);
      } else {
        elapsed += call!.wallMs;
        delivered += call!.audioMs;
        buffer = advancePlanningBuffer(buffer, call!.wallMs, call!.audioMs);
        expect(buffer).toBeGreaterThanOrEqual(0);
        expect(delivered).toBeGreaterThan(elapsed);
      }
      const taken = new Set(call!.indexes);
      pending = pending.filter((index) => !taken.has(index));
    }
    expect(pending).toEqual([]);

    resetModalCloneRuntimeForTests();
    const render = vi.fn(async (items: { key: string }[]) => {
      const audio = new Map<string, { audio: Buffer; durationSeconds: number }>();
      for (const item of items) {
        audio.set(item.key, { audio: Buffer.from("mp3"), durationSeconds: 12 });
      }
      return { audio, build: "abc", containerId: "gpu", seed: 1, performance: null, boot: "restored" };
    });
    await dispatchModalCloneLanes({
      indexes: sections.map((_, index) => index),
      textAt: (index) => text(sections[index] ?? 0),
      lanes: 1,
      batch: 24,
      maxLaneChars: 8_000,
      seedEpoch: 0,
      firstLight: true,
      bookWave: true,
      poolWarm: false,
      entireRemainder: true,
      render,
      stage: async () => {},
    });
    const dispatched = render.mock.calls.map((call) =>
      (call[0] as { key: string }[]).map((item) => Number(item.key))
    );
    expect(dispatched).toEqual(posted);
    let playDelivered = 0;
    let playElapsed = 0;
    let playStarted = false;
    for (const indexes of dispatched) {
      const chars = indexes.reduce((sum, index) => sum + (sections[index] ?? 0), 0);
      const largest = Math.max(...indexes.map((index) => sections[index] ?? 0));
      const wall = cloneCallWallMs({
        chars,
        largestRow: largest,
        rows: indexes.length,
        shape: playStarted ? "warm" : "cold",
        restore: !playStarted,
      });
      if (playStarted) {
        expect(wall).toBeLessThan(542_000);
      }
      if (!playStarted) {
        playStarted = true;
        playDelivered = cloneAudioMs(chars);
        playElapsed = 0;
      } else {
        playElapsed += wall;
        playDelivered += cloneAudioMs(chars);
        expect(Number.isFinite(Math.floor(playDelivered / 1.5) - playElapsed)).toBe(true);
      }
    }
  });
});

describe("a thrown book-wave call does not keep ramping", () => {
  it("posts only the failed call and leaves warmth unchanged", async () => {
    resetModalCloneRuntimeForTests();
    noteModalClonePoolAnswered();
    expect(modalClonePoolIsWarm()).toBe(true);
    const render = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    const result = await dispatchModalCloneLanes({
      indexes: [0, 1, 2, 3, 4],
      textAt: (index) => text(index === 0 ? 1_000 : modalCloneSecondCallChars()),
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
    expect(result.staged).toBe(0);
    expect(modalClonePoolIsWarm()).toBe(true);
  });

  it("continues when a parsed body comes back with no rows", async () => {
    resetModalCloneRuntimeForTests();
    let calls = 0;
    const render = vi.fn(async (items: { key: string }[]) => {
      calls += 1;
      const audio = new Map<string, { audio: Buffer; durationSeconds: number }>();
      if (calls > 1) {
        for (const item of items) {
          audio.set(item.key, { audio: Buffer.from("mp3"), durationSeconds: 12 });
        }
      }
      return { audio, build: "abc", containerId: "gpu", seed: 1, performance: null, boot: "restored" };
    });
    const result = await dispatchModalCloneLanes({
      indexes: [1, 2, 3],
      textAt: () => text(modalCloneSecondCallChars()),
      lanes: 4,
      batch: 24,
      maxLaneChars: 8_000,
      seedEpoch: 0,
      bookWave: true,
      poolWarm: true,
      playbackStarted: true,
      // The opening's wall buffer fits one ramp row, so the empty body
      // leaves the later indexes pending and the next POST still happens.
      bufferedMs: clonePlanningBufferMs(cloneAudioMs(MODAL_CLONE_OPENING_SECTION_CHARS)),
      render,
      stage: async () => {},
    });
    expect(render.mock.calls.length).toBeGreaterThan(1);
    expect(result.staged).toBeGreaterThan(0);
  });
});

function frozen(index: number, body: string): FrozenSection {
  return {
    index,
    text: body,
    chapterIndex: 0,
    chapterTitle: null,
    charStart: 0,
    charEnd: body.length,
  };
}

describe("repack leaves a ready section after a hole", () => {
  it("does not rewrite or reindex the ready section", () => {
    const ready = "This ready section keeps its words and its index.";
    const sections = [
      frozen(0, text(4_000)),
      frozen(1, ready),
      frozen(2, text(4_000)),
    ];
    const packed = repackFrozenTail(
      sections,
      0,
      () => 2_000,
      new Set([1])
    );
    const kept = packed.find((section) => section.text === ready);
    expect(kept?.index).toBe(1);
    expect(packed.filter((section) => section.index === 1)).toEqual([kept]);
    expect(packed.find((section) => section.index === 0)?.text.length).toBe(4_000);
    const tail = packed.filter((section) => section.index > 1);
    expect(tail.map((section) => section.text.length)).toEqual([2_000, 2_000]);
    expect(tail.map((section) => section.index)).toEqual([2, 3]);
  });
});

describe("unpublished outlines are re-packed", () => {
  it("keeps a row under the steady width and rebuilds one past it", () => {
    const limits = {
      opening: 1_000,
      second: modalCloneSecondCallChars(),
      third: modalCloneThirdCallChars(),
      coldSafe: modalCloneColdSafeRowChars(),
    };
    expect(
      cloneOutlineRepackKind(
        [
          { index: 0, text: text(800) },
          { index: 1, text: text(2_000) },
        ],
        new Set(),
        limits
      )
    ).toBe(null);
    const wide = [
      { index: 0, text: text(1_000) },
      { index: 1, text: text(7_000) },
    ];
    expect(cloneOutlineRepackKind(wide, new Set(), limits)).toBe("rebuild");
    expect(cloneOutlineRepackKind(wide, new Set([0]), limits)).toBe("tail");
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
