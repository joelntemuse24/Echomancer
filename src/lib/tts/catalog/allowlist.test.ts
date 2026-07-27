import { describe, expect, it } from "vitest";
import {
  isAllowedCatalogVoice,
  isAllowedSpeechModel,
  vendorFromModelId,
} from "./allowlist";

describe("TTS allowlist", () => {
  it("allows curated vendors", () => {
    expect(isAllowedSpeechModel("google/gemini-3.1-flash-tts-preview")).toBe(
      true
    );
    expect(isAllowedSpeechModel("qwen/qwen-audio-3.0-tts-flash")).toBe(true);
    expect(isAllowedSpeechModel("minimax/speech-2.8-hd")).toBe(true);
    expect(isAllowedSpeechModel("microsoft/mai-voice-2-flash")).toBe(true);
    expect(isAllowedSpeechModel("x-ai/grok-voice-tts-1.0")).toBe(true);
    expect(isAllowedSpeechModel("xai/grok-tts")).toBe(true);
  });

  it("blocks Zonos, Kokoro, and other junk", () => {
    expect(isAllowedSpeechModel("zyphra/zonos-v0.1-transformer")).toBe(false);
    expect(isAllowedSpeechModel("hexgrad/kokoro-82m")).toBe(false);
    expect(isAllowedSpeechModel("deepgram/aura-2")).toBe(false);
    expect(isAllowedSpeechModel("canopylabs/orpheus-3b-0.1-ft")).toBe(false);
    expect(isAllowedSpeechModel("sesame/csm-1b")).toBe(false);
    expect(isAllowedSpeechModel("mistralai/voxtral-mini-tts-2603")).toBe(false);
  });

  it("parses vendor from model ids", () => {
    expect(vendorFromModelId("or:google/gemini-3.1:Kore")).toBe("google");
    expect(vendorFromModelId("minimax/speech-2.8-hd")).toBe("minimax");
  });

  it("allows static gemini/grok catalog voices", () => {
    expect(
      isAllowedCatalogVoice({
        provider: "gemini",
        model: "google/gemini-2.5-flash-tts",
      })
    ).toBe(true);
    expect(
      isAllowedCatalogVoice({ provider: "grok", model: "xai/grok-tts" })
    ).toBe(true);
    expect(
      isAllowedCatalogVoice({
        provider: "openrouter",
        model: "hexgrad/kokoro-82m",
      })
    ).toBe(false);
  });
});
