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
      created_at: 1,
      deleted_at: null,
    };
    const card = clonedVoiceToCatalog(row);
    expect(card.id).toBe(`clone:${row.id}`);
    expect(card.provider).toBe("fish");
    expect(card.providerVoiceId).toBe(row.fish_voice_id);
    expect(card.displayName).toMatch(/^Alex/);
    expect(card.tags).toContain("cloned");
  });
});
