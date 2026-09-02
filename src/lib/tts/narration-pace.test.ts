import { describe, expect, it } from "vitest";
import {
  DEFAULT_NARRATION_SPEED,
  EXTREME_FAST_WPM,
  FISH_SPEED_MAX,
  FISH_SPEED_MIN,
  TARGET_LONGFORM_WPM,
  calibrateNarrationSpeed,
} from "./narration-pace";

describe("narration pace constants", () => {
  it("targets long-form WPM and only allows a light Fish speed clamp", () => {
    expect(TARGET_LONGFORM_WPM).toBeGreaterThanOrEqual(150);
    expect(TARGET_LONGFORM_WPM).toBeLessThanOrEqual(155);
    expect(DEFAULT_NARRATION_SPEED).toBe(1);
    expect(FISH_SPEED_MIN).toBe(0.9);
    expect(FISH_SPEED_MAX).toBe(1);
    expect(EXTREME_FAST_WPM).toBeGreaterThan(TARGET_LONGFORM_WPM);
  });
});

describe("calibrateNarrationSpeed", () => {
  it("does not slow a ~150 WPM take — pauses are the product, not vowels", () => {
    expect(
      calibrateNarrationSpeed({
        currentSpeed: 1,
        wordCount: 150,
        durationSec: 60,
      })
    ).toBe(1);
  });

  it("nudges only when measured WPM is extreme, and never below 0.9", () => {
    // 210 words in 60s = 210 WPM at speed 1 → clamp to 0.9, not 0.85
    const next = calibrateNarrationSpeed({
      currentSpeed: 1,
      wordCount: 210,
      durationSec: 60,
    });
    expect(next).toBe(FISH_SPEED_MIN);
    expect(next).toBeGreaterThanOrEqual(0.9);
    expect(next).toBeLessThan(1);
  });

  it("does not speed past 1.0 when speech is already slow", () => {
    expect(
      calibrateNarrationSpeed({
        currentSpeed: 1,
        wordCount: 120,
        durationSec: 60,
      })
    ).toBeLessThanOrEqual(FISH_SPEED_MAX);
    expect(
      calibrateNarrationSpeed({
        currentSpeed: 1,
        wordCount: 80,
        durationSec: 60,
      })
    ).toBe(1);
  });

  it("leaves speed alone when pause ratio already sounds like a book", () => {
    // 210 WPM on speech-time but 20% silence — do not stretch vowels
    expect(
      calibrateNarrationSpeed({
        currentSpeed: 1,
        wordCount: 210,
        durationSec: 60,
        silenceSec: 12,
      })
    ).toBe(1);
  });
});
