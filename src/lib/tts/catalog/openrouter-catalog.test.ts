import { describe, expect, it, vi } from "vitest";
import { usdPerMillionCharsForModel } from "./openrouter-catalog";

describe("usdPerMillionCharsForModel", () => {
  it("lets a confirmed override win over a derived pricing.prompt value", () => {
    // $0.0001/unit would derive to $100/M — still ignore it for MiniMax HD
    expect(
      usdPerMillionCharsForModel("minimax/speech-02-hd", "0.00005")
    ).toBe(100);
    expect(
      usdPerMillionCharsForModel("microsoft/mai-voice-2", "0.000001")
    ).toBe(22);
    expect(
      usdPerMillionCharsForModel("qwen/qwen-audio-3.0-tts-flash", "9")
    ).toBe(15);
  });

  it("picks tier-specific overrides before vendor catch-alls", () => {
    expect(usdPerMillionCharsForModel("fish-audio/s2.1-pro-free:free")).toBe(0);
    expect(usdPerMillionCharsForModel("fish-audio/s2.1-pro")).toBe(15);
    expect(usdPerMillionCharsForModel("minimax/speech-02-turbo")).toBe(60);
    expect(usdPerMillionCharsForModel("microsoft/mai-voice-2-flash")).toBe(15);
    expect(
      usdPerMillionCharsForModel("qwen/qwen-audio-3.0-tts-plus")
    ).toBe(20);
    expect(usdPerMillionCharsForModel("x-ai/grok-voice-tts-1.0")).toBe(15);
  });

  it("converts a plausible derived rate correctly", () => {
    // $0.000004 per char → $4 per million
    expect(
      usdPerMillionCharsForModel("google/gemini-2.5-flash-preview-tts", "0.000004")
    ).toBe(4);
  });

  it("returns undefined for an implausible derived rate so pricing.ts falls back", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // $0.01/unit → $10,000/M chars — wrong unit, refuse to quote
    expect(
      usdPerMillionCharsForModel("google/gemini-2.5-flash-preview-tts", "0.01")
    ).toBeUndefined();
    // $0.0000001/unit → $0.1/M — below the floor
    expect(
      usdPerMillionCharsForModel("google/gemini-2.5-flash-preview-tts", "0.0000001")
    ).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns undefined when there is no override and no prompt price", () => {
    expect(
      usdPerMillionCharsForModel("google/gemini-2.5-flash-preview-tts")
    ).toBeUndefined();
  });
});
