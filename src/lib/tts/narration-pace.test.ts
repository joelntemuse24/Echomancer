import { describe, expect, it } from "vitest";
import {
  DEFAULT_NARRATION_SPEED,
  DREW_APP_SPEED_MAX,
  DREW_APP_SPEED_MIN,
  FISH_SPEED_MAX,
  FISH_SPEED_MIN,
  TARGET_LONGFORM_WPM,
  calibrateNarrationSpeed,
  drewSpeedForRequest,
  initialNarrationSpeed,
  keepsOwnPace,
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

describe("initialNarrationSpeed", () => {
  it("keeps Echomancer Andrew at 1.0 on academic text", () => {
    expect(
      initialNarrationSpeed({
        catalogVoiceId: "echomancer-andrew",
        text: ACADEMIC,
      })
    ).toBe(1);
  });

  it("keeps Drew at 1.0 on academic text — 1.0 is already his natural pace", () => {
    // The container renders 1.0 at Kokoro speed 0.88, so the academic
    // heuristic here would stack a second slowdown on top of a voice that is
    // already at Andrew's pace. This is the drift that moved later Andrew
    // sections to ~0.85.
    expect(
      initialNarrationSpeed({ catalogVoiceId: "drew", text: ACADEMIC })
    ).toBe(1);
    expect(
      initialNarrationSpeed({ catalogVoiceId: "drew", text: CONVERSATIONAL })
    ).toBe(1);
  });

  it("still starts an unmodelled clone or stock narrator slow on academic text", () => {
    expect(
      initialNarrationSpeed({
        catalogVoiceId: "clone:96a74157-aaaa-4bbb-8ccc-ddddeeeeffff",
        text: ACADEMIC,
      })
    ).toBeLessThan(1);
    expect(
      initialNarrationSpeed({ catalogVoiceId: "fish-narrator", text: ACADEMIC })
    ).toBeLessThan(1);
  });
});

describe("Drew pace", () => {
  it("marks the voices whose pace must not be re-calibrated", () => {
    expect(keepsOwnPace("drew")).toBe(true);
    expect(keepsOwnPace("echomancer-andrew")).toBe(true);
    expect(keepsOwnPace("ava")).toBe(false);
    expect(keepsOwnPace(null)).toBe(false);
  });

  it("clamps the app speed and leaves 1.0 exactly at 1.0", () => {
    // The worker multiplies by 0.88; this only clamps, so 1.0 must survive as
    // 1.0 or the container would apply 0.88 to an already-scaled number.
    expect(drewSpeedForRequest(1)).toBe(1);
    expect(drewSpeedForRequest(undefined)).toBe(1);
    expect(drewSpeedForRequest(0.5)).toBe(DREW_APP_SPEED_MIN);
    expect(drewSpeedForRequest(9)).toBe(DREW_APP_SPEED_MAX);
    expect(drewSpeedForRequest(0.9)).toBe(0.9);
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
