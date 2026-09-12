import { describe, expect, it } from "vitest";
import {
  ANDREW_NEURAL_VOICE_ID,
  FISH_NARRATOR_VOICE_ID,
  STANDARD_CATALOG_VOICE_ID,
  isStandardCatalogId,
  isStandardVoice,
} from "./standard-voice";

describe("standard voice identity", () => {
  it("treats catalog id standard as the default stock voice", () => {
    expect(STANDARD_CATALOG_VOICE_ID).toBe("standard");
    expect(ANDREW_NEURAL_VOICE_ID).toBe("en-US-AndrewNeural");
    expect(isStandardCatalogId("standard")).toBe(true);
    expect(isStandardCatalogId(FISH_NARRATOR_VOICE_ID)).toBe(false);
  });

  it("does not treat Fish clones or legacy narrator as Standard", () => {
    expect(
      isStandardVoice({
        id: "clone:abc",
        provider: "fish",
        providerVoiceId: "ref-1",
      })
    ).toBe(false);
    expect(
      isStandardVoice({
        id: FISH_NARRATOR_VOICE_ID,
        provider: "openrouter",
        model: "fish-audio/s2.1-pro-free:free",
      })
    ).toBe(false);
  });

  it("matches edge provider / Andrew Neural ids", () => {
    expect(
      isStandardVoice({
        id: "standard",
        provider: "edge",
        providerVoiceId: ANDREW_NEURAL_VOICE_ID,
        model: "edge/en-US-AndrewNeural",
      })
    ).toBe(true);
    expect(
      isStandardVoice({
        provider: "edge",
        providerVoiceId: ANDREW_NEURAL_VOICE_ID,
      })
    ).toBe(true);
  });
});
