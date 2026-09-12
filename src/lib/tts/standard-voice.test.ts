import { describe, expect, it } from "vitest";
import {
  ANDREW_NEURAL_VOICE_ID,
  AVA_CATALOG_VOICE_ID,
  AVA_NEURAL_VOICE_ID,
  FISH_NARRATOR_VOICE_ID,
  LIBBY_CATALOG_VOICE_ID,
  LIBBY_NEURAL_VOICE_ID,
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

describe("standard voice identity", () => {
  it("treats catalog id standard as the default stock voice", () => {
    expect(STANDARD_CATALOG_VOICE_ID).toBe("standard");
    expect(ANDREW_NEURAL_VOICE_ID).toBe("en-US-AndrewNeural");
    expect(isStandardCatalogId("standard")).toBe(true);
    expect(isStandardCatalogId(FISH_NARRATOR_VOICE_ID)).toBe(false);
    expect(SLIM_STOCK_VOICE_IDS).toEqual([
      "standard",
      "ava",
      "libby",
      "randolph",
    ]);
  });

  it("pins friendly product names", () => {
    expect(stockDisplayName("standard")).toBe("Standard");
    expect(stockDisplayName("ava")).toBe("Ava");
    expect(stockDisplayName("libby")).toBe("Libby");
    expect(stockDisplayName("randolph")).toBe("Randolph");
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

  it("matches Andrew Neural ids only — not every Edge voice", () => {
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
    expect(
      isStandardVoice({
        id: AVA_CATALOG_VOICE_ID,
        provider: "edge",
        providerVoiceId: AVA_NEURAL_VOICE_ID,
        model: "edge/en-US-AvaNeural",
      })
    ).toBe(false);
    expect(
      isStandardVoice({
        id: LIBBY_CATALOG_VOICE_ID,
        provider: "edge",
        providerVoiceId: LIBBY_NEURAL_VOICE_ID,
      })
    ).toBe(false);
  });

  it("treats Ava and Libby as Edge stock, Randolph as Google", () => {
    expect(
      isEdgeStockVoice({
        id: AVA_CATALOG_VOICE_ID,
        provider: "edge",
        providerVoiceId: AVA_NEURAL_VOICE_ID,
      })
    ).toBe(true);
    expect(
      isEdgeStockVoice({
        id: LIBBY_CATALOG_VOICE_ID,
        provider: "edge",
        providerVoiceId: LIBBY_NEURAL_VOICE_ID,
      })
    ).toBe(true);
    expect(
      isEdgeStockVoice({
        id: RANDOLPH_CATALOG_VOICE_ID,
        provider: "google",
        providerVoiceId: RANDOLPH_GOOGLE_VOICE_ID,
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

  it("maps Edge stock voices to the matching browser target", () => {
    expect(edgeBrowserTarget({ id: "ava" })?.neuralId).toBe(AVA_NEURAL_VOICE_ID);
    expect(edgeBrowserTarget({ id: "libby" })?.neuralId).toBe(
      LIBBY_NEURAL_VOICE_ID
    );
    expect(edgeBrowserTarget({ id: "standard" })?.neuralId).toBe(
      ANDREW_NEURAL_VOICE_ID
    );
    expect(edgeBrowserTarget({ id: "randolph", provider: "google" })).toBeNull();
  });
});
