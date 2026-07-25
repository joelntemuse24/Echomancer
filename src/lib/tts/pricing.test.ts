import { describe, it, expect } from "vitest";
import {
  estimateAudioHours,
  estimateTtsCogsUsd,
  estimatePriceEur,
  CHARS_PER_AUDIO_HOUR,
  TARGET_PRICE_EUR,
} from "./pricing";
import type { CatalogVoice } from "./types";

const wavenet: CatalogVoice = {
  id: "test-wavenet",
  provider: "google",
  providerVoiceId: "en-US-Wavenet-D",
  displayName: "Test",
  language: "English",
  locale: "en-US",
  gender: "male",
  style: "narration",
  tags: [],
  latencyClass: "balanced",
  model: "wavenet",
  recommendedForLongForm: true,
  supportsNativeStream: false,
  maxCharsPerRequest: 4000,
  usdPerMillionChars: 4,
};

const gemini: CatalogVoice = {
  ...wavenet,
  id: "test-gemini",
  provider: "gemini",
  model: "gemini-2.5-flash-tts",
  usdPerMillionChars: undefined,
  usdPerAudioHour: 0.9,
};

describe("pricing", () => {
  it("estimates hours from chars", () => {
    expect(estimateAudioHours(CHARS_PER_AUDIO_HOUR)).toBe(1);
    expect(estimateAudioHours(0)).toBe(0);
  });

  it("WaveNet COGS is low for a full novel", () => {
    const chars = 480_000; // ~9h
    const cogs = estimateTtsCogsUsd(chars, wavenet);
    expect(cogs).toBeCloseTo(1.92, 1);
  });

  it("Gemini 2.5 COGS tracks audio hours", () => {
    const chars = CHARS_PER_AUDIO_HOUR * 2;
    const cogs = estimateTtsCogsUsd(chars, gemini);
    expect(cogs).toBeCloseTo(1.8, 1);
  });

  it("suggests a price near target for WaveNet typical book", () => {
    // ~8h at WaveNet ~$1.7 COGS → with 2x markup + fixed lands near €4–6
    const price = estimatePriceEur({
      charCount: 430_000,
      voice: wavenet,
      markup: 2,
      fixedEur: 0.5,
      fxUsdToEur: 0.92,
      minEur: 1.99,
    });
    expect(price.targetPriceEur).toBe(TARGET_PRICE_EUR);
    expect(price.suggestedPriceEur).toBeGreaterThanOrEqual(1.99);
    expect(price.suggestedPriceEur).toBeLessThan(12);
  });
});
