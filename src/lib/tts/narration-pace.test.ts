import { describe, expect, it } from "vitest";
import {
  DEFAULT_NARRATION_SPEED,
  FISH_SPEED_MAX,
  FISH_SPEED_MIN,
  TARGET_LONGFORM_WPM,
  calibrateNarrationSpeed,
  initialNarrationSpeed,
} from "./narration-pace";

const ACADEMIC = [
  "Abstract",
  "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.",
].join("\n\n");

const CONVERSATIONAL = "A sentence. ".repeat(40);

describe("narration pace constants", () => {
  it("targets 150–155 speech WPM and clamps Fish speed 0.75–1.0", () => {
    expect(TARGET_LONGFORM_WPM).toBeGreaterThanOrEqual(150);
    expect(TARGET_LONGFORM_WPM).toBeLessThanOrEqual(155);
    expect(DEFAULT_NARRATION_SPEED).toBe(1);
    expect(FISH_SPEED_MIN).toBe(0.75);
    expect(FISH_SPEED_MAX).toBe(1);
  });
});

describe("calibrateNarrationSpeed", () => {
  it("scales 194 speech WPM at speed 1 toward ~0.75–0.82", () => {
    // Production QA: 1562 words, 482.8s speech (552.8s wall − 70s silence) → 194 WPM
    const next = calibrateNarrationSpeed({
      currentSpeed: 1,
      wordCount: 1562,
      durationSec: 552.8,
      silenceSec: 70,
    });
    expect(next).toBeGreaterThanOrEqual(0.75);
    expect(next).toBeLessThanOrEqual(0.82);
    expect(next).toBeLessThan(1);
  });

  it("does not abort to 1.0 when pause_ratio is 0.13", () => {
    // 194 words / 60s speech, 9s silence / 69s wall ≈ 0.13 pause share
    const next = calibrateNarrationSpeed({
      currentSpeed: 1,
      wordCount: 194,
      durationSec: 69,
      silenceSec: 9,
    });
    expect(next).not.toBe(1);
    expect(next).toBeGreaterThanOrEqual(0.75);
    expect(next).toBeLessThanOrEqual(0.82);
  });

  it("does not slow a ~150 WPM take", () => {
    expect(
      calibrateNarrationSpeed({
        currentSpeed: 1,
        wordCount: 150,
        durationSec: 60,
      })
    ).toBe(1);
  });

  it("does not speed past 1.0 when speech is already slow", () => {
    expect(
      calibrateNarrationSpeed({
        currentSpeed: 1,
        wordCount: 80,
        durationSec: 60,
      })
    ).toBe(1);
  });
});

describe("initialNarrationSpeed", () => {
  it("starts clones below 1.0 so section 0 is not stuck at Fish default", () => {
    const next = initialNarrationSpeed({
      catalogVoiceId: "clone:96a74157-aaaa-4bbb-8ccc-ddddeeeeffff",
      text: CONVERSATIONAL,
    });
    expect(next).toBeGreaterThanOrEqual(0.82);
    expect(next).toBeLessThanOrEqual(0.88);
    expect(next).toBeLessThan(1);
  });

  it("starts dense academic below 1.0 even on stock Narrator", () => {
    const next = initialNarrationSpeed({
      catalogVoiceId: "fish-narrator",
      text: ACADEMIC,
    });
    expect(next).toBeGreaterThanOrEqual(0.82);
    expect(next).toBeLessThanOrEqual(0.88);
    expect(next).toBeLessThan(1);
  });

  it("keeps stock Narrator at 1.0 for conversational prose", () => {
    expect(
      initialNarrationSpeed({
        catalogVoiceId: "fish-narrator",
        text: CONVERSATIONAL,
      })
    ).toBe(1);
  });
});
