import { describe, expect, it } from "vitest";
import {
  FINE_SEEK_WINDOW_SECONDS,
  SKIP_SECONDS,
  clampSeekSeconds,
  fineSeekAnchor,
  fineSeekBounds,
  fineSeekWindow,
  formatPlayClock,
  seekableDuration,
} from "./seek";

describe("fineSeekBounds", () => {
  it("is absent without a known duration", () => {
    expect(fineSeekBounds(10, 0)).toBeNull();
    expect(fineSeekBounds(10, Number.NaN)).toBeNull();
  });

  it("centers a two-minute window and clamps at the ends", () => {
    expect(fineSeekBounds(1000, 3600)).toEqual({ start: 940, end: 1060 });
    expect(fineSeekBounds(10, 3600)).toEqual({ start: 0, end: 120 });
    expect(fineSeekBounds(3590, 3600)).toEqual({ start: 3480, end: 3600 });
  });

  it("shrinks to a short clip instead of refusing it", () => {
    expect(fineSeekBounds(10, 15 * 60)).toEqual({ start: 0, end: 120 });
    expect(fineSeekBounds(10, 45)).toEqual({ start: 0, end: 45 });
  });
});

describe("fineSeekAnchor", () => {
  it("sits on a half-minute grid", () => {
    expect(fineSeekAnchor(0)).toBe(0);
    expect(fineSeekAnchor(15)).toBe(30);
    expect(fineSeekAnchor(59)).toBe(30);
    expect(fineSeekAnchor(61)).toBe(90);
    expect(fineSeekAnchor(-5)).toBe(0);
  });
});

describe("fineSeekWindow", () => {
  it("keeps a pinned window while a fine drag holds it", () => {
    expect(fineSeekWindow(1000, 3600, { start: 940, end: 1060 })).toEqual({
      start: 940,
      end: 1060,
    });
  });

  it("centres the grid anchor, so playback slides it at most once a minute", () => {
    expect(fineSeekWindow(1000, 3600)).toEqual({ start: 930, end: 1050 });
    expect(fineSeekWindow(1019, 3600)).toEqual({ start: 930, end: 1050 });
    expect(fineSeekWindow(1020, 3600)).toEqual({ start: 990, end: 1110 });
    expect(fineSeekWindow(10, 3600)).toEqual({ start: 0, end: 120 });
    expect(fineSeekWindow(3590, 3600)).toEqual({ start: 3480, end: 3600 });
  });

  it("always contains the playhead and shrinks to a short clip", () => {
    for (const at of [0, 1, 59, 60, 121, 900, 1799, 1800, 3599]) {
      const win = fineSeekWindow(at, 3600);
      expect(win).not.toBeNull();
      expect(at).toBeGreaterThanOrEqual(win!.start);
      expect(at).toBeLessThanOrEqual(win!.end);
      expect(win!.end - win!.start).toBe(120);
    }
    expect(fineSeekWindow(10, 45, null)).toEqual({ start: 0, end: 45 });
    expect(fineSeekWindow(10, 0, null)).toBeNull();
  });
});

describe("thresholds", () => {
  it("skips ten seconds", () => {
    expect(SKIP_SECONDS).toBe(10);
  });

  it("uses a two-minute precise window", () => {
    expect(FINE_SEEK_WINDOW_SECONDS).toBe(120);
  });
});

describe("clampSeekSeconds", () => {
  it("clamps a skip to the audio", () => {
    expect(clampSeekSeconds(5, -10, 300)).toBe(0);
    expect(clampSeekSeconds(295, 10, 300)).toBe(300);
    expect(clampSeekSeconds(100, 10, 300)).toBe(110);
  });
});

describe("formatPlayClock", () => {
  it("reads m:ss and h:mm:ss", () => {
    expect(formatPlayClock(0)).toBe("0:00");
    expect(formatPlayClock(65)).toBe("1:05");
    expect(formatPlayClock(3599)).toBe("59:59");
    expect(formatPlayClock(3600)).toBe("1:00:00");
    expect(formatPlayClock(-5)).toBe("0:00");
    expect(formatPlayClock(Number.NaN)).toBe("0:00");
  });
});
describe("seekableDuration", () => {
  it("uses the element duration when it is finite and positive", () => {
    expect(seekableDuration(600, 590)).toBe(600);
  });

  it("falls back to the stored length before metadata (NaN) or for a live-style Infinity", () => {
    expect(seekableDuration(NaN, 590)).toBe(590);
    expect(seekableDuration(0, 590)).toBe(590);
    expect(seekableDuration(Infinity, 590)).toBe(590);
  });

  it("is 0, never non-finite, when nothing is known", () => {
    expect(seekableDuration(NaN, null)).toBe(0);
    expect(seekableDuration(Infinity, undefined)).toBe(0);
    expect(seekableDuration(undefined, NaN)).toBe(0);
  });
});
