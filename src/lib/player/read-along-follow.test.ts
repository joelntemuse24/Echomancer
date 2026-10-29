import { describe, expect, it } from "vitest";
import {
  FOLLOWING,
  FOLLOW_IDLE_RESUME_MS,
  extendWindow,
  followScrollDelta,
  idleRemainingMs,
  initialWindow,
  pauseFollow,
  resumeFollow,
  shouldAutoResume,
  tapCharIndex,
  windowCovering,
  wordStartInText,
  centerScrollDelta,
} from "./read-along-follow";

describe("follow state", () => {
  it("starts following", () => {
    expect(FOLLOWING).toEqual({ following: true, lastInteractionAt: null });
    expect(shouldAutoResume(FOLLOWING, 1_000_000)).toBe(false);
  });

  it("pauses on a manual scroll and resumes after the idle window", () => {
    const paused = pauseFollow(10_000);
    expect(paused.following).toBe(false);
    expect(idleRemainingMs(paused, 10_500)).toBe(FOLLOW_IDLE_RESUME_MS - 500);
    expect(shouldAutoResume(paused, 10_000 + FOLLOW_IDLE_RESUME_MS - 1)).toBe(false);
    expect(shouldAutoResume(paused, 10_000 + FOLLOW_IDLE_RESUME_MS)).toBe(true);
    expect(idleRemainingMs(paused, 99_000)).toBe(0);
  });

  it("restarts the idle window when the reader keeps scrolling", () => {
    let state = pauseFollow(1_000);
    expect(shouldAutoResume(state, 8_000)).toBe(false);
    // Another wheel event while paused: still paused, window pushed back.
    state = pauseFollow(6_000);
    expect(shouldAutoResume(state, 10_000)).toBe(false);
    expect(shouldAutoResume(state, 14_000)).toBe(true);
  });

  it("keeps a deliberate pause until the listener resumes it", () => {
    const deliberate = pauseFollow(null);
    expect(shouldAutoResume(deliberate, 10_000_000)).toBe(false);
    expect(idleRemainingMs(deliberate, 10_000_000)).toBe(Number.POSITIVE_INFINITY);
    expect(resumeFollow()).toEqual(FOLLOWING);
    expect(shouldAutoResume(resumeFollow(), 10_000_000)).toBe(false);
  });
});

describe("tap to seek", () => {
  const block = { charStart: 100, text: "The harbor was quiet after the rain." };

  it("lands on the word under the pointer, not the paragraph start", () => {
    const afterRain = block.text.indexOf("rain");
    expect(tapCharIndex(block, afterRain + 2)).toBe(block.charStart + afterRain);
    // Sentence-initial words too: the caller snaps to the sentence.
    const harbor = block.text.indexOf("harbor");
    expect(tapCharIndex(block, harbor)).toBe(block.charStart + harbor);
  });

  it("treats a tap in whitespace as the next word", () => {
    const quiet = block.text.indexOf("quiet");
    // A pointer in the gap right before "quiet".
    expect(tapCharIndex(block, quiet - 1)).toBe(block.charStart + quiet);
  });

  it("clamps to the first and last words", () => {
    expect(tapCharIndex(block, -50)).toBe(block.charStart);
    expect(tapCharIndex(block, 9_999)).toBe(
      block.charStart + block.text.lastIndexOf("rain")
    );
  });

  it("falls back to the paragraph start when the browser has no caret hit test", () => {
    expect(tapCharIndex(block, null)).toBe(block.charStart);
  });

  it("handles an empty paragraph without looping", () => {
    expect(wordStartInText("", 4)).toBe(0);
    expect(wordStartInText("   ", 1)).toBe(0);
  });
});

describe("scroll placement", () => {
  const view = { top: 100, height: 400 };

  it("centres a passage that left the band", () => {
    const below = { top: 700, height: 60 };
    expect(centerScrollDelta(view, below)).toBe(700 - 100 + 30 - 200);
    expect(followScrollDelta(view, below)).toBe(430);
  });

  it("leaves a passage already in the middle alone", () => {
    expect(followScrollDelta(view, { top: 280, height: 60 })).toBeNull();
  });

  it("pulls a passage scrolled above the band back to the middle", () => {
    const above = { top: 60, height: 60 };
    expect(followScrollDelta(view, above)).toBe(-40 + 30 - 200);
  });

  it("anchors a passage taller than the window near the head", () => {
    const tall = { top: 900, height: 500 };
    expect(followScrollDelta(view, tall)).toBe(900 - 100 - 100);
    // Head on screen: no scroll, so a long paragraph is not jerked around
    // while the reader reads down it.
    expect(followScrollDelta(view, { top: 180, height: 500 })).toBeNull();
    expect(followScrollDelta(view, { top: 100, height: 500 })).toBeNull();
    // Head gone off the top, or sitting below the fold: bring it back.
    // (-200 is in viewport coordinates, so 300px above the scroller's top.)
    expect(followScrollDelta(view, { top: -200, height: 500 })).toBe(-400);
    expect(followScrollDelta(view, { top: 600, height: 500 })).toBe(600 - 100 - 100);
  });

  it("never scrolls when the scroller has no height", () => {
    expect(followScrollDelta({ top: 0, height: 0 }, { top: 500, height: 40 })).toBeNull();
  });
});

describe("render window", () => {
  const total = 2_000;

  it("keeps context behind the playhead and more ahead of it", () => {
    expect(initialWindow(600, total)).toEqual({ start: 560, end: 760 });
    expect(initialWindow(3, total)).toEqual({ start: 0, end: 163 });
    expect(initialWindow(1_990, total)).toEqual({ start: 1_950, end: total });
  });

  it("does not move while the playhead is inside the mounted slice", () => {
    const window = { start: 500, end: 700 };
    expect(windowCovering(window, 620, total)).toBe(window);
  });

  it("appends when the playhead nears the end, without dropping rows above it", () => {
    const window = { start: 500, end: 700 };
    const next = windowCovering(window, 690, total);
    expect(next.start).toBe(500);
    expect(next.end).toBeGreaterThan(700);
    expect(next.end).toBe(690 + 160);
  });

  it("re-windows when the playhead jumps backwards (a chapter seek)", () => {
    const window = { start: 900, end: 1_100 };
    expect(windowCovering(window, 40, total)).toEqual({ start: 0, end: 200 });
    // A playhead just inside the mounted head also re-windows, so there is
    // always text above the highlight to scroll into.
    expect(windowCovering(window, 905, total)).toEqual({ start: 865, end: 1_065 });
    // So does one past the mounted end: a scrub or a resume from a pause.
    expect(windowCovering(window, 1_101, total)).toEqual({ start: 1_061, end: 1_261 });
  });

  it("ignores a playhead that has no block yet", () => {
    const window = { start: 0, end: 160 };
    expect(windowCovering(window, -1, total)).toBe(window);
    expect(windowCovering(window, 0, 0)).toBe(window);
  });

  it("extends toward the edge a paused reader scrolls to", () => {
    const window = { start: 300, end: 460 };
    expect(extendWindow(window, total, true, false)).toEqual({ start: 240, end: 460 });
    expect(extendWindow(window, total, false, true)).toEqual({ start: 300, end: 520 });
    expect(extendWindow(window, total, true, true)).toEqual({ start: 240, end: 520 });
  });

  it("stops at the ends of the book", () => {
    expect(extendWindow({ start: 0, end: 160 }, total, true, false)).toEqual({ start: 0, end: 160 });
    expect(extendWindow({ start: 0, end: total }, total, false, true)).toEqual({ start: 0, end: total });
  });
});
