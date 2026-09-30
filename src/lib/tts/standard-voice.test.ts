import { describe, expect, it } from "vitest";
import {
  ANDREW_NEURAL_VOICE_ID,
  CLARA_CATALOG_VOICE_ID,
  CLARA_FISH_REFERENCE_ID,
  FISH_NARRATOR_VOICE_ID,
  AVA_CATALOG_VOICE_ID,
  AVA_NEURAL_VOICE_ID,
  LIBBY_CATALOG_VOICE_ID,
  LIBBY_NEURAL_VOICE_ID,
  MICHELLE_CATALOG_VOICE_ID,
  MICHELLE_NEURAL_VOICE_ID,
  RANDOLPH_CATALOG_VOICE_ID,
  RANDOLPH_GOOGLE_VOICE_ID,
  RANDOLPH_GOOGLE_VOICE_ID_LEGACY,
  SLIM_STOCK_VOICE_IDS,
  STANDARD_CATALOG_VOICE_ID,
  edgeBrowserTarget,
  isAvaVoice,
  isLibbyVoice,
  isEdgeStockVoice,
  isMichelleVoice,
  isRandolphVoice,
  isStandardCatalogId,
  isStandardVoice,
  coercePlainCatalogVoiceId,
  plainStockLock,
  stockDisplayName,
  stripExpressiveLabel,
} from "./standard-voice";
import { isCuratedFishStockVoice } from "./curated-fish-stock";

describe("standard voice identity", () => {
  it("treats catalog id standard as the default stock voice", () => {
    expect(STANDARD_CATALOG_VOICE_ID).toBe("standard");
    expect(ANDREW_NEURAL_VOICE_ID).toBe("en-US-AndrewNeural");
    expect(isStandardCatalogId("standard")).toBe(true);
    expect(isStandardCatalogId(FISH_NARRATOR_VOICE_ID)).toBe(false);
    expect(AVA_NEURAL_VOICE_ID).toBe("en-US-AvaNeural");
    expect(LIBBY_NEURAL_VOICE_ID).toBe("en-GB-LibbyNeural");
    expect(SLIM_STOCK_VOICE_IDS).toEqual([
      "standard",
      "ava",
      "libby",
      "randolph",
    ]);
  });

  it("pins friendly product names", () => {
    expect(stockDisplayName("standard")).toBe("Andrew");
    expect(stockDisplayName("ava")).toBe("Ava");
    expect(stockDisplayName("libby")).toBe("Libby");
    expect(stockDisplayName("michelle")).toBe("Michelle");
    expect(stockDisplayName("clara")).toBe("Clara");
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

  it("matches Andrew Neural ids only — not Ava", () => {
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
        id: AVA_CATALOG_VOICE_ID,
        provider: "edge",
        providerVoiceId: AVA_NEURAL_VOICE_ID,
        model: "edge/en-US-AvaNeural",
      })
    ).toBe(false);
    expect(isAvaVoice({ id: AVA_CATALOG_VOICE_ID })).toBe(true);
    expect(isAvaVoice({ providerVoiceId: "en-US-Ava:DragonHDLatestNeural" })).toBe(
      false
    );
    expect(isMichelleVoice({ id: MICHELLE_CATALOG_VOICE_ID })).toBe(true);
  });

  it("treats Ava as Edge stock, Clara as curated Fish, Randolph as Google", () => {
    expect(
      isEdgeStockVoice({
        id: AVA_CATALOG_VOICE_ID,
        provider: "edge",
        providerVoiceId: AVA_NEURAL_VOICE_ID,
      })
    ).toBe(true);
    expect(
      isEdgeStockVoice({
        id: MICHELLE_CATALOG_VOICE_ID,
        provider: "edge",
        providerVoiceId: MICHELLE_NEURAL_VOICE_ID,
      })
    ).toBe(true);
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

  it("maps Edge stock voices to the matching browser target", () => {
    expect(edgeBrowserTarget({ id: "libby" })?.neuralId).toBe(LIBBY_NEURAL_VOICE_ID);
    expect(edgeBrowserTarget({ id: "libby" })?.locale).toBe("en-GB");
    expect(edgeBrowserTarget({ id: "ava" })?.neuralId).toBe(AVA_NEURAL_VOICE_ID);
    expect(edgeBrowserTarget({ id: "ava" })?.shortName).toBe("Ava");
    expect(edgeBrowserTarget({ id: "michelle" })?.neuralId).toBe(
      MICHELLE_NEURAL_VOICE_ID
    );
    expect(edgeBrowserTarget({ id: "standard" })?.neuralId).toBe(
      ANDREW_NEURAL_VOICE_ID
    );
    expect(edgeBrowserTarget({ id: "clara", provider: "fish" })).toBeNull();
    expect(edgeBrowserTarget({ id: "randolph", provider: "google" })).toBeNull();
    expect(
      edgeBrowserTarget({ id: "standard", provider: "fish" })
    ).toBeNull();
    expect(
      edgeBrowserTarget({ id: "michelle", provider: "fish" })
    ).toBeNull();
  });

  it("maps an Expressive id onto the plain stock voice", () => {
    expect(coercePlainCatalogVoiceId("standard-expressive")).toBe("standard");
    expect(coercePlainCatalogVoiceId("Andrew (Expressive)")).toBe("standard");
    expect(coercePlainCatalogVoiceId("randolph-expressive")).toBe("randolph");
    expect(coercePlainCatalogVoiceId("expressive")).toBe("standard");
    expect(coercePlainCatalogVoiceId("clara")).toBe("libby");
    expect(coercePlainCatalogVoiceId("libby")).toBe("libby");
    expect(coercePlainCatalogVoiceId("clone:abc")).toBe("clone:abc");
    expect(stripExpressiveLabel("Andrew (Expressive)")).toBe("Andrew");
    expect(plainStockLock("standard")).toMatchObject({
      provider: "edge",
      providerVoiceId: "en-US-AndrewNeural",
    });
    expect(plainStockLock("randolph")?.provider).toBe("google");
    expect(plainStockLock("libby")).toMatchObject({
      provider: "edge",
      providerVoiceId: "en-GB-LibbyNeural",
    });
    expect(plainStockLock(coercePlainCatalogVoiceId("clara"))).toMatchObject({
      provider: "edge",
      providerVoiceId: "en-GB-LibbyNeural",
    });
    expect(isLibbyVoice({ id: LIBBY_CATALOG_VOICE_ID })).toBe(true);
  });

  it("does not treat a Fish provider as Edge or Google stock", () => {
    expect(
      isEdgeStockVoice({
        id: "standard",
        provider: "fish",
        providerVoiceId: "a50f1ee074124ba2b1dc44623f99abbe",
      })
    ).toBe(false);
    expect(
      isEdgeStockVoice({
        id: "michelle",
        provider: "fish",
      })
    ).toBe(false);
    expect(
      isRandolphVoice({
        id: "randolph",
        provider: "fish",
        providerVoiceId: "a50f1ee074124ba2b1dc44623f99abbe",
      })
    ).toBe(false);
  });
});
