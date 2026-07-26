import { describe, expect, it } from "vitest";
import type { CatalogVoice } from "@/lib/tts/types";
import {
  curateListenVoices,
  enrichCatalogVoice,
  friendlyVoiceName,
  inferAccent,
  inferVibe,
  isListenFriendly,
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
          providerVoiceId: "alloy",
          displayName: "Alloy",
          model: "openai/gpt-4o-mini-tts",
          latencyClass: "fast",
        })
      )
    ).toBe(true);
  });

  it("curates a short listen list without duplicate personas", () => {
    const enriched = [
      enrichCatalogVoice(
        voice({
          id: "a",
          providerVoiceId: "alloy",
          displayName: "Alloy",
          gender: "female",
          model: "openai/gpt-4o-mini-tts",
          latencyClass: "fast",
        })
      ),
      enrichCatalogVoice(
        voice({
          id: "b",
          providerVoiceId: "nova",
          displayName: "Nova",
          gender: "female",
          model: "openai/gpt-4o-mini-tts",
          latencyClass: "fast",
          style: "warm",
          tags: ["warm"],
        })
      ),
      enrichCatalogVoice(
        voice({
          id: "c",
          providerVoiceId: "onyx",
          displayName: "Onyx",
          gender: "male",
          model: "openai/gpt-4o-mini-tts",
          latencyClass: "fast",
          tags: ["calm", "deep"],
        })
      ),
      enrichCatalogVoice(
        voice({
          id: "hd",
          providerVoiceId: "studio",
          displayName: "Studio",
          model: "minimax/speech-02-hd",
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
