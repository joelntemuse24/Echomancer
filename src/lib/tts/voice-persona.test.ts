import { describe, expect, it } from "vitest";
import type { CatalogVoice } from "@/lib/tts/types";
import {
  enrichCatalogVoice,
  friendlyVoiceName,
  inferAccent,
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
  it("names the default stock voice Andrew", () => {
    const enriched = enrichCatalogVoice(
      voice({
        id: "standard",
        provider: "edge",
        providerVoiceId: "en-US-AndrewNeural",
        displayName: "Standard",
        gender: "male",
        model: "edge/en-US-AndrewNeural",
        accentHint: "american",
      })
    );
    expect(enriched.friendlyName).toBe("Andrew");
    expect(enriched.displayName).toBe("Andrew");
    expect(enriched.friendlyName).not.toMatch(/microsoft|fish|neural/i);
    expect(isListenFriendly(enriched)).toBe(true);
    expect(isTakehomeFriendly(enriched)).toBe(true);
  });

  it("pins Michelle, Clara, and Randolph without vendor jargon", () => {
    const michelle = enrichCatalogVoice(
      voice({
        id: "michelle",
        provider: "edge",
        providerVoiceId: "en-US-MichelleNeural",
        displayName: "Michelle",
        gender: "female",
        model: "edge/en-US-MichelleNeural",
        accentHint: "american",
      })
    );
    const clara = enrichCatalogVoice(
      voice({
        id: "clara",
        provider: "fish",
        providerVoiceId: "a50f1ee074124ba2b1dc44623f99abbe",
        displayName: "Clara",
        gender: "female",
        model: "s2.1-pro-free",
        accentHint: "american",
      })
    );
    const randolph = enrichCatalogVoice(
      voice({
        id: "randolph",
        provider: "google",
        providerVoiceId: "en-GB-Neural2-O",
        displayName: "Randolph",
        gender: "male",
        locale: "en-GB",
        model: "google/en-GB-Neural2-O",
        accentHint: "british",
      })
    );
    expect(michelle.friendlyName).toBe("Michelle");
    expect(michelle.displayName).toBe("Michelle");
    expect(clara.friendlyName).toBe("Clara");
    expect(clara.displayName).not.toMatch(/klett|librivox|fish/i);
    expect(randolph.friendlyName).toBe("Randolph");
    expect(randolph.displayName).not.toMatch(/neural2|google|en-GB/i);
    expect(isListenFriendly(michelle)).toBe(true);
    expect(isListenFriendly(clara)).toBe(true);
    expect(isListenFriendly(randolph)).toBe(true);
  });

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

  it("strips locale prefixes so Microsoft voices are not 'En Us Harper'", () => {
    expect(
      friendlyVoiceName(
        voice({
          id: "ms",
          providerVoiceId: "en-US-Harper:MAI-Voice-2",
          displayName: "en-US-Harper",
          locale: "en-US",
          model: "microsoft/mai-voice-2-flash",
        })
      )
    ).toBe("Harper");

    expect(
      enrichCatalogVoice(
        voice({
          id: "ms",
          providerVoiceId: "en-US-Harper:MAI-Voice-2",
          displayName: "en-US-Harper",
          locale: "en-US",
          model: "microsoft/mai-voice-2-flash",
        })
      ).friendlyName
    ).toBe("Harper · American");

    expect(
      enrichCatalogVoice(
        voice({
          id: "de",
          providerVoiceId: "de-DE-Klaus:MAI-Voice-2",
          displayName: "de-DE-Klaus",
          locale: "de-DE",
          language: "German",
          gender: "male",
          model: "microsoft/mai-voice-2-flash",
        })
      ).friendlyName
    ).toBe("Klaus");
  });

  it("honors accentHint over noisy tags", () => {
    expect(
      inferAccent(
        voice({
          id: "g",
          providerVoiceId: "Aoede",
          displayName: "Aoede",
          locale: "en-GB",
          accentHint: "british",
          tags: ["american", "openrouter"],
          model: "google/gemini-3.1-flash-tts-preview",
        })
      )
    ).toBe("british");
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
});
