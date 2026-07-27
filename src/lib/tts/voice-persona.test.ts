import { describe, expect, it } from "vitest";
import type { CatalogVoice } from "@/lib/tts/types";
import {
  curateListenVoices,
  enrichCatalogVoice,
  friendlyVoiceName,
  inferAccent,
  inferVibe,
  isListenFriendly,
  isTakehomeFriendly,
} from "./voice-persona";

function voice(partial: Partial<CatalogVoice> & Pick<CatalogVoice, "id" | "providerVoiceId" | "displayName" | "model">): CatalogVoice {
  return {
    provider: "openrouter",
    language: "English",
    locale: "en-US",
    gender: "female",
    style: "narration",
    tags: [],
    latencyClass: "balanced",
    recommendedForLongForm: true,
    supportsNativeStream: true,
    maxCharsPerRequest: 2000,
    ...partial,
  };
}

describe("voice-persona", () => {
  it("builds friendly names without model junk", () => {
    expect(
      friendlyVoiceName(
        voice({
          id: "1",
          providerVoiceId: "nova",
          displayName: "Nova · GPT-4o Mini TTS",
          model: "openai/gpt-4o-mini-tts",
        })
      )
    ).toBe("Nova");
  });

  it("infers British vs American accents", () => {
    expect(
      inferAccent(
        voice({
          id: "1",
          providerVoiceId: "en-GB-Neural2-A",
          displayName: "British A",
          locale: "en-GB",
          model: "google/tts",
        })
      )
    ).toBe("british");

    expect(
      inferAccent(
        voice({
          id: "2",
          providerVoiceId: "alloy",
          displayName: "Alloy",
          locale: "en-US",
          model: "openai/gpt-4o-mini-tts",
        })
      )
    ).toBe("american");
  });

  it("reads Kokoro bf_/bm_ as British even when qualityNotes mention American", () => {
    expect(
      inferAccent(
        voice({
          id: "or:hexgrad/kokoro-82m:bf_emma",
          providerVoiceId: "bf_emma",
          displayName: "Emma",
          locale: "en-GB",
          model: "hexgrad/kokoro-82m",
          qualityNotes:
            "Kokoro is an open-weight TTS model. American English voices included.",
        })
      )
    ).toBe("british");

    expect(
      inferAccent(
        voice({
          id: "or:hexgrad/kokoro-82m:bm_george",
          providerVoiceId: "bm_george",
          displayName: "George",
          locale: "en-GB",
          model: "hexgrad/kokoro-82m",
          qualityNotes: "American English default catalog description",
        })
      )
    ).toBe("british");

    expect(
      inferAccent(
        voice({
          id: "or:hexgrad/kokoro-82m:af_bella",
          providerVoiceId: "af_bella",
          displayName: "Bella",
          locale: "en-US",
          model: "hexgrad/kokoro-82m",
        })
      )
    ).toBe("american");
  });

  it("infers vibe from tags and known names", () => {
    expect(
      inferVibe(
        voice({
          id: "1",
          providerVoiceId: "Charon",
          displayName: "Charon",
          tags: ["deep", "calm"],
          model: "google/gemini-2.5-flash-tts",
        })
      )
    ).toBe("calm");

    expect(
      inferVibe(
        voice({
          id: "2",
          providerVoiceId: "Puck",
          displayName: "Puck",
          tags: ["bright"],
          model: "google/gemini-2.5-flash-tts",
        })
      )
    ).toBe("upbeat");
  });

  it("marks HD and zonos as not listen-friendly", () => {
    expect(
      isListenFriendly(
        voice({
          id: "hd",
          providerVoiceId: "hd",
          displayName: "HD",
          model: "minimax/speech-02-hd",
          tags: ["hd"],
        })
      )
    ).toBe(false);

    expect(
      isListenFriendly(
        voice({
          id: "fast",
          providerVoiceId: "Kore",
          displayName: "Kore",
          model: "google/gemini-3.1-flash-tts-preview",
          latencyClass: "fast",
        })
      )
    ).toBe(true);
  });

  it("excludes tiny-context engines and Kokoro from full audiobook", () => {
    expect(
      isTakehomeFriendly(
        voice({
          id: "z",
          providerVoiceId: "british_male",
          displayName: "British Male",
          model: "zyphra/zonos-v0.1-transformer",
          maxCharsPerRequest: 350,
        })
      )
    ).toBe(false);

    expect(
      isTakehomeFriendly(
        voice({
          id: "k",
          providerVoiceId: "am_echo",
          displayName: "Am Echo",
          model: "hexgrad/kokoro-82m",
          maxCharsPerRequest: 800,
        })
      )
    ).toBe(false);

    expect(
      isTakehomeFriendly(
        voice({
          id: "g",
          providerVoiceId: "Kore",
          displayName: "Kore",
          model: "google/gemini-3.1-flash-tts-preview",
          maxCharsPerRequest: 3000,
        })
      )
    ).toBe(true);
  });

  it("curates a short listen list without duplicate personas", () => {
    const enriched = [
      enrichCatalogVoice(
        voice({
          id: "a",
          providerVoiceId: "Kore",
          displayName: "Kore",
          gender: "female",
          model: "google/gemini-3.1-flash-tts-preview",
          latencyClass: "fast",
        })
      ),
      enrichCatalogVoice(
        voice({
          id: "b",
          providerVoiceId: "Aoede",
          displayName: "Aoede",
          gender: "female",
          model: "google/gemini-3.1-flash-tts-preview",
          latencyClass: "fast",
          style: "warm",
          tags: ["warm"],
        })
      ),
      enrichCatalogVoice(
        voice({
          id: "c",
          providerVoiceId: "Charon",
          displayName: "Charon",
          gender: "male",
          model: "google/gemini-3.1-flash-tts-preview",
          latencyClass: "fast",
          tags: ["calm", "deep"],
        })
      ),
      enrichCatalogVoice(
        voice({
          id: "hd",
          providerVoiceId: "English_CaptivatingStoryteller",
          displayName: "Storyteller",
          model: "minimax/speech-2.8-hd",
          tags: ["hd"],
        })
      ),
    ];

    const listen = curateListenVoices(enriched, 12);
    expect(listen.every((v) => v.id !== "hd")).toBe(true);
    expect(listen.length).toBeGreaterThan(0);
    expect(listen.length).toBeLessThanOrEqual(12);
  });
});
