import { describe, expect, it } from "vitest";
import {
  clearStockVoicePick,
  readStockVoicePick,
  rememberedCloneOnRestore,
  resolveStockSelection,
  writeStockVoicePick,
} from "./stock-voice-pick";

function memoryStore() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

describe("stock voice pick", () => {
  it("round-trips an explicit pick and folds Expressive onto the plain voice", () => {
    const storage = memoryStore();
    writeStockVoicePick(
      { catalogVoiceId: "ava", delivery: "standard" },
      storage
    );
    expect(readStockVoicePick(storage)).toEqual({
      catalogVoiceId: "ava",
      delivery: "standard",
    });
    // Andrew is retired: a saved Andrew/Randolph/standard pick lands on Drew.
    storage.setItem(
      "ec_stock_voice_pick",
      JSON.stringify({ catalogVoiceId: "randolph", delivery: "expressive" })
    );
    expect(readStockVoicePick(storage)).toEqual({
      catalogVoiceId: "drew",
      delivery: "standard",
    });
    storage.setItem(
      "ec_stock_voice_pick",
      JSON.stringify({ catalogVoiceId: "standard-expressive", delivery: "expressive" })
    );
    expect(readStockVoicePick(storage)).toEqual({
      catalogVoiceId: "drew",
      delivery: "standard",
    });
    storage.setItem(
      "ec_stock_voice_pick",
      JSON.stringify({ catalogVoiceId: "andrew", delivery: "standard" })
    );
    expect(readStockVoicePick(storage)).toEqual({
      catalogVoiceId: "drew",
      delivery: "standard",
    });
  });

  it("moves a saved Clara pick onto Libby", () => {
    const storage = memoryStore();
    storage.setItem(
      "ec_stock_voice_pick",
      JSON.stringify({ catalogVoiceId: "clara", delivery: "standard" })
    );
    expect(readStockVoicePick(storage)).toEqual({
      catalogVoiceId: "libby",
      delivery: "standard",
    });
  });

  it("moves a saved Michelle pick onto Ava", () => {
    const storage = memoryStore();
    storage.setItem(
      "ec_stock_voice_pick",
      JSON.stringify({ catalogVoiceId: "michelle", delivery: "expressive" })
    );
    expect(readStockVoicePick(storage)).toEqual({
      catalogVoiceId: "ava",
      delivery: "standard",
    });
  });

  it("ignores empty and broken storage", () => {
    const storage = memoryStore();
    expect(readStockVoicePick(storage)).toBeNull();
    storage.setItem("ec_stock_voice_pick", "{");
    expect(readStockVoicePick(storage)).toBeNull();
    storage.setItem("ec_stock_voice_pick", JSON.stringify({ delivery: "standard" }));
    expect(readStockVoicePick(storage)).toBeNull();
  });

  it("remembers a Walter pick and never replaces a missing one with Drew", () => {
    const storage = memoryStore();
    writeStockVoicePick(
      { catalogVoiceId: "sowell", delivery: "standard" },
      storage
    );
    expect(readStockVoicePick(storage)).toEqual({
      catalogVoiceId: "sowell",
      delivery: "standard",
    });
    expect(
      resolveStockSelection({
        availableIds: ["drew", "echomancer-andrew", "ava", "libby", "ryan", "sowell"],
        explicitId: "sowell",
        suggestedId: "drew",
      })
    ).toBe("sowell");
    expect(
      resolveStockSelection({
        availableIds: ["drew", "ava", "libby", "ryan"],
        explicitId: "sowell",
        suggestedId: "drew",
      })
    ).toBeNull();
    // The same rule holds for a Drew pick when its endpoint is down.
    expect(
      resolveStockSelection({
        availableIds: ["echomancer-andrew", "ava", "libby"],
        explicitId: "drew",
        suggestedId: "ava",
      })
    ).toBeNull();
  });

  it("keeps an explicit pick ahead of the narrator suggestion", () => {
    const availableIds = ["drew", "ava", "clara", "randolph"];
    expect(
      resolveStockSelection({
        availableIds,
        explicitId: "randolph",
        suggestedId: "drew",
      })
    ).toBe("randolph");
    expect(
      resolveStockSelection({
        availableIds,
        explicitId: "missing",
        suggestedId: "ava",
      })
    ).toBe("ava");
    expect(
      resolveStockSelection({
        availableIds,
        explicitId: null,
        suggestedId: null,
      })
    ).toBe("drew");
  });

  it("remembers a clone id and restores it only when that clone is still theirs", () => {
    const storage = memoryStore();
    writeStockVoicePick(
      { catalogVoiceId: "clone:abc", delivery: "standard" },
      storage
    );
    expect(readStockVoicePick(storage)).toEqual({
      catalogVoiceId: "clone:abc",
      delivery: "standard",
    });
    expect(
      rememberedCloneOnRestore({
        selectedId: null,
        rememberedId: "clone:abc",
        cloneIds: ["clone:abc"],
        loaded: true,
      })
    ).toEqual({
      selectedId: "clone:abc",
      rememberedId: "clone:abc",
      dropRemembered: false,
      clearTouched: false,
    });
  });

  it("does not select or drop a saved clone while the voice list is still loading", () => {
    expect(
      rememberedCloneOnRestore({
        selectedId: null,
        rememberedId: "clone:abc",
        cloneIds: [],
        loaded: false,
      })
    ).toEqual({
      selectedId: null,
      rememberedId: "clone:abc",
      dropRemembered: false,
      clearTouched: false,
    });
  });

  it("drops a deleted clone and does not leave it selected", () => {
    const storage = memoryStore();
    writeStockVoicePick(
      { catalogVoiceId: "clone:gone", delivery: "standard" },
      storage
    );
    const restored = rememberedCloneOnRestore({
      selectedId: "clone:gone",
      rememberedId: "clone:gone",
      cloneIds: ["clone:other"],
      loaded: true,
    });
    expect(restored).toEqual({
      selectedId: null,
      rememberedId: null,
      dropRemembered: true,
      clearTouched: true,
    });
    if (restored.dropRemembered) clearStockVoicePick(storage);
    expect(readStockVoicePick(storage)).toBeNull();
  });

  it("does not replace a stock tap with a remembered clone", () => {
    expect(
      rememberedCloneOnRestore({
        selectedId: "libby",
        rememberedId: "clone:abc",
        cloneIds: ["clone:abc"],
        loaded: true,
      }).selectedId
    ).toBe("libby");
  });
});
