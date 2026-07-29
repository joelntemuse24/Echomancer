import { describe, expect, it } from "vitest";
import {
  GEMINI_ACCENT_LOCALES,
  geminiDirectedInput,
  modelSupportsAccentVariants,
  modelSupportsStyleInstructions,
  narrationStylePrompt,
} from "./accent-prompt";
import { resolveStylePrompt } from "./resolve-style-prompt";
import { enrichCatalogVoice, inferAccent } from "./voice-persona";
import type { CatalogVoice } from "./types";

describe("accent-prompt", () => {
  it("steers Gemini English into four accent locales", () => {
    expect(GEMINI_ACCENT_LOCALES.map((x) => x.accent)).toEqual([
      "american",
      "british",
      "australian",
      "irish",
    ]);
    expect(modelSupportsAccentVariants("google/gemini-2.5-flash-preview-tts")).toBe(
      true
    );
    expect(modelSupportsAccentVariants("minimax/speech-02-hd")).toBe(false);
  });

  it("only claims style instructions for vendors that honour them", () => {
    expect(
      modelSupportsStyleInstructions("google/gemini-2.5-flash-preview-tts")
    ).toBe(true);
    expect(modelSupportsStyleInstructions("openai/gpt-4o-mini-tts")).toBe(true);
    expect(modelSupportsStyleInstructions("minimax/speech-02-hd")).toBe(false);
    expect(modelSupportsStyleInstructions("microsoft/mai-voice-2")).toBe(false);
    expect(modelSupportsStyleInstructions("qwen/qwen-tts-flash")).toBe(false);
    expect(modelSupportsStyleInstructions("x-ai/grok-voice-tts-1.0")).toBe(false);
    expect(modelSupportsStyleInstructions(undefined)).toBe(false);
  });

  it("builds soft accent-specific narration prompts", () => {
    expect(narrationStylePrompt("british")).toMatch(/British English/);
    expect(narrationStylePrompt("british")).not.toMatch(/IMPORTANT/);
    expect(narrationStylePrompt("australian")).toMatch(/Australian/);
    expect(narrationStylePrompt("irish")).toMatch(/Irish/);
    expect(narrationStylePrompt("american")).toMatch(/General American/);
  });

  it("wraps short Gemini input with accent direction", () => {
    const directed = geminiDirectedInput("Hello there.", "british");
    expect(directed).toMatch(/British English accent/);
    expect(directed).toContain("Hello there.");
  });

  it("resolves stylePrompt from catalog, then locale fallback", () => {
    expect(
      resolveStylePrompt({
        catalogStylePrompt: "Speak British.",
        locale: "en-US",
      })
    ).toBe("Speak British.");
    expect(resolveStylePrompt({ locale: "en-GB" })).toMatch(/British/);
    expect(resolveStylePrompt({ locale: "en-AU" })).toMatch(/Australian/);
    expect(resolveStylePrompt({ accent: "irish" })).toMatch(/Irish/);
  });

  it("labels Gemini en-GB cards as British, not American", () => {
    const base: CatalogVoice = {
      id: "or:google/gemini-2.5-flash-preview-tts:Aoede:en-GB",
      provider: "openrouter",
      providerVoiceId: "Aoede",
      displayName: "Aoede",
      language: "English",
      locale: "en-GB",
      gender: "female",
      style: "narration",
      tags: ["google", "british"],
      latencyClass: "fast",
      model: "google/gemini-2.5-flash-preview-tts",
      recommendedForLongForm: true,
      supportsNativeStream: true,
      maxCharsPerRequest: 3000,
      stylePrompt: narrationStylePrompt("british"),
      accentHint: "british",
    };
    expect(inferAccent(base)).toBe("british");
    const enriched = enrichCatalogVoice(base);
    expect(enriched.accent).toBe("british");
    expect(enriched.friendlyName).toContain("British");
    expect(enriched.stylePrompt).toMatch(/British/);
  });
});
