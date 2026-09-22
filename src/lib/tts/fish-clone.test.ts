import { describe, expect, it } from "vitest";
import {
  catalogIdForClone,
  cloneRowIdFromCatalogId,
  clonedVoiceToCatalog,
  isFishCloneCatalogId,
  isFishCloneVoice,
  type ClonedVoiceRow,
} from "./fish-clone";

describe("fish-clone helpers", () => {
  it("round-trips catalog ids", () => {
    expect(catalogIdForClone("abc")).toBe("clone:abc");
    expect(cloneRowIdFromCatalogId("clone:abc")).toBe("abc");
    expect(isFishCloneCatalogId("clone:abc")).toBe(true);
    expect(isFishCloneCatalogId("fish-narrator")).toBe(false);
  });

  it("detects fish clone voices", () => {
    expect(isFishCloneVoice({ provider: "fish" })).toBe(true);
    expect(isFishCloneVoice({ id: "clone:x", tags: [] })).toBe(true);
    expect(
      isFishCloneVoice({ id: "fish-narrator", tags: ["cloned"] })
    ).toBe(true);
    expect(
      isFishCloneVoice({
        id: "fish-narrator",
        provider: "openrouter",
        tags: [],
      })
    ).toBe(false);
    expect(
      isFishCloneVoice({
        id: "clara",
        provider: "fish",
        providerVoiceId: "a50f1ee074124ba2b1dc44623f99abbe",
      })
    ).toBe(false);
  });

  it("maps a DB row to a catalog card", () => {
    const row: ClonedVoiceRow = {
      id: "11111111-1111-1111-1111-111111111111",
      user_id: "anon_x",
      fish_voice_id: "9a9cf47702da476aa4629e2506d4a857",
      title: "Alex",
      sample_storage_path: "clones/11111111-1111-1111-1111-111111111111/sample.wav",
      state: "trained",
      model: "s2.1-pro-free",
      accent: null,
      created_at: 1,
      deleted_at: null,
    };
    const card = clonedVoiceToCatalog(row);
    expect(card.id).toBe(`clone:${row.id}`);
    expect(card.provider).toBe("fish");
    expect(card.providerVoiceId).toBe(row.fish_voice_id);
    expect(card.displayName).toBe("Alex · American");
    expect(card.locale).toBe("en-US");
    expect(card.accentHint).toBe("american");
    expect(card.accent).toBe("american");
    expect(card.tags).toContain("cloned");
  });

  it("labels a stored British clone as British", () => {
    const card = clonedVoiceToCatalog({
      id: "shauna",
      user_id: "user_joel",
      fish_voice_id: "fish-shauna",
      title: "Shauna",
      sample_storage_path: null,
      state: "trained",
      model: "s2.1-pro-free",
      accent: "british",
      created_at: 1,
      deleted_at: null,
    });
    expect(card.displayName).toBe("Shauna · British");
    expect(card.friendlyName).toBe("Shauna · British");
    expect(card.locale).toBe("en-GB");
    expect(card.accentHint).toBe("british");
    expect(card.accent).toBe("british");
  });
});
