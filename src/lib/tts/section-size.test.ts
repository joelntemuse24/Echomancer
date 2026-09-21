import { describe, expect, it } from "vitest";
import {
  FISH_EVEN_PACK_MIN_CHARS,
  FISH_HARD_MAX_CHARS,
  FISH_TARGET_CHARS,
  STREAM_WINDOW_CHARS,
  evenTakehomeTargetChars,
  hardMaxCharsForModel,
  maxCharsForModel,
  streamWindowChars,
} from "./section-size";
import { GOOGLE_SSML_HARD_MAX_BYTES } from "./ssml-pauses";

describe("maxCharsForModel", () => {
  it("trusts the catalog value above every fallback", () => {
    expect(
      maxCharsForModel({ provider: "grok", model: "openai/tts", catalogMax: 111 })
    ).toBe(111);
  });

  it("ignores a nonsensical catalog value", () => {
    expect(maxCharsForModel({ model: "google/gemini-2.5-flash-tts", catalogMax: 0 })).toBe(
      3000
    );
  });

  it("uses per-model limits before per-provider ones", () => {
    expect(maxCharsForModel({ provider: "grok", model: "openai/gpt-4o-mini-tts" })).toBe(
      4000
    );
    expect(maxCharsForModel({ provider: "gemini", model: "google/gemini-2.5-flash-tts" })).toBe(
      3000
    );
  });

  it("keeps small-context models small", () => {
    expect(maxCharsForModel({ model: "zyphra/zonos-v0.1" })).toBe(350);
    expect(maxCharsForModel({ model: "hexgrad/kokoro" })).toBe(800);
  });

  it("falls back to the provider then to a safe default", () => {
    expect(maxCharsForModel({ provider: "grok" })).toBe(8000);
    expect(maxCharsForModel({ provider: "fish" })).toBe(8000);
    expect(maxCharsForModel({ provider: "gemini" })).toBe(2800);
    expect(maxCharsForModel({ provider: "openrouter", model: "some/unknown" })).toBe(
      2000
    );
    expect(maxCharsForModel({})).toBe(2000);
    expect(maxCharsForModel({ provider: "google" })).toBe(4500);
  });
});

describe("streamWindowChars", () => {
  it("keeps live listen windows short for fast first sound", () => {
    expect(streamWindowChars(8000)).toBe(STREAM_WINDOW_CHARS);
  });

  it("never exceeds the model's own limit", () => {
    expect(streamWindowChars(350)).toBe(350);
  });
});

describe("evenTakehomeTargetChars", () => {
  it("even-packs a mid-size book across one Fish fan-out wave", () => {
    // ~34k + fanout 5 → five ~6.8k slices, not 2k + four 8k.
    expect(evenTakehomeTargetChars(34_000, 5)).toBe(6_800);
  });

  it("uses fewest waves that still fit under the Fish hard max", () => {
    // 5 workers × 9200 = 46k per wave → 50k needs two waves.
    expect(evenTakehomeTargetChars(50_000, 5)).toBe(5_000);
  });

  it("floors tiny books at FISH_EVEN_PACK_MIN_CHARS", () => {
    expect(FISH_EVEN_PACK_MIN_CHARS).toBe(1_500);
    expect(evenTakehomeTargetChars(500, 5)).toBe(FISH_EVEN_PACK_MIN_CHARS);
    expect(evenTakehomeTargetChars(0, 5)).toBe(FISH_EVEN_PACK_MIN_CHARS);
  });

  it("caps the even target at FISH_TARGET_CHARS so overflow room remains", () => {
    expect(evenTakehomeTargetChars(40_000, 5)).toBe(FISH_TARGET_CHARS);
    expect(evenTakehomeTargetChars(34_000, 4)).toBe(FISH_TARGET_CHARS);
    expect(evenTakehomeTargetChars(100_000, 5)).toBeLessThanOrEqual(
      FISH_TARGET_CHARS
    );
    expect(evenTakehomeTargetChars(100_000, 5)).toBeLessThanOrEqual(
      FISH_HARD_MAX_CHARS
    );
  });

  it("treats a missing fan-out as one worker", () => {
    expect(evenTakehomeTargetChars(34_000, 0)).toBe(FISH_TARGET_CHARS);
    expect(evenTakehomeTargetChars(1_200, Number.NaN)).toBe(
      FISH_EVEN_PACK_MIN_CHARS
    );
  });
});

describe("hardMaxCharsForModel", () => {
  it("caps Google Whole-book under Cloud TTS's 5000-byte SSML limit", () => {
    expect(
      hardMaxCharsForModel({ provider: "google", catalogMax: 4500 })
    ).toBe(GOOGLE_SSML_HARD_MAX_BYTES);
    expect(GOOGLE_SSML_HARD_MAX_BYTES).toBeLessThanOrEqual(5000);
    expect(
      hardMaxCharsForModel({ provider: "google", catalogMax: 4500 })
    ).toBeLessThan(
      hardMaxCharsForModel({ provider: "edge", catalogMax: 4500 })
    );
  });
});
