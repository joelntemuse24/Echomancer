import { describe, expect, it } from "vitest";
import {
  ANDREW_NEURAL_VOICE_ID,
  CLARA_CATALOG_VOICE_ID,
  CLARA_FISH_REFERENCE_ID,
  FISH_NARRATOR_VOICE_ID,
  RANDOLPH_CATALOG_VOICE_ID,
  RANDOLPH_GOOGLE_VOICE_ID,
  RANDOLPH_GOOGLE_VOICE_ID_LEGACY,
  SLIM_STOCK_VOICE_IDS,
  STANDARD_CATALOG_VOICE_ID,
  edgeBrowserTarget,
  isEdgeStockVoice,
  isRandolphVoice,
  isStandardCatalogId,
  isStandardVoice,
  stockDisplayName,
} from "./standard-voice";
import { isCuratedFishStockVoice } from "./curated-fish-stock";

describe("standard voice identity", () => {
  it("treats catalog id standard as the default stock voice", () => {
    expect(STANDARD_CATALOG_VOICE_ID).toBe("standard");
    expect(ANDREW_NEURAL_VOICE_ID).toBe("en-US-AndrewNeural");
    expect(isStandardCatalogId("standard")).toBe(true);
    expect(isStandardCatalogId(FISH_NARRATOR_VOICE_ID)).toBe(false);
    expect(SLIM_STOCK_VOICE_IDS).toEqual(["standard", "randolph"]);
  });

  it("pins friendly product names for shipped stock", () => {
    expect(stockDisplayName("standard")).toBe("Standard");
    expect(stockDisplayName("randolph")).toBe("Randolph");
    expect(stockDisplayName("clara")).toBe("Clara");
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

  it("matches Andrew Neural ids only", () => {
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
        id: RANDOLPH_CATALOG_VOICE_ID,
        provider: "google",
        providerVoiceId: RANDOLPH_GOOGLE_VOICE_ID,
      })
    ).toBe(false);
  });

  it("treats Clara as curated Fish (not listed) and Randolph as Google", () => {
    expect(
      isCuratedFishStockVoice({
        id: CLARA_CATALOG_VOICE_ID,
        providerVoiceId: CLARA_FISH_REFERENCE_ID,
      })
    ).toBe(true);
    expect(
      isEdgeStockVoice({
        id: CLARA_CATALOG_VOICE_ID,
        provider: "fish",
        providerVoiceId: CLARA_FISH_REFERENCE_ID,
      })
    ).toBe(false);
    expect(
      isRandolphVoice({
        id: RANDOLPH_CATALOG_VOICE_ID,
        provider: "google",
        providerVoiceId: RANDOLPH_GOOGLE_VOICE_ID,
      })
    ).toBe(true);
    expect(
      isRandolphVoice({
        providerVoiceId: RANDOLPH_GOOGLE_VOICE_ID_LEGACY,
      })
    ).toBe(true);
  });

  it("maps Edge stock voices to Andrew; Clara and Randolph skip browser TTS", () => {
    expect(edgeBrowserTarget({ id: "standard" })?.neuralId).toBe(
      ANDREW_NEURAL_VOICE_ID
    );
    expect(edgeBrowserTarget({ id: "clara", provider: "fish" })).toBeNull();
    expect(edgeBrowserTarget({ id: "randolph", provider: "google" })).toBeNull();
  });
});
