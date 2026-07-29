import { describe, expect, it } from "vitest";
import {
  STREAM_WINDOW_CHARS,
  maxCharsForModel,
  streamWindowChars,
} from "./section-size";

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
    expect(maxCharsForModel({ provider: "gemini" })).toBe(2800);
    expect(maxCharsForModel({ provider: "openrouter", model: "some/unknown" })).toBe(
      2000
    );
    expect(maxCharsForModel({})).toBe(2000);
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
