import { describe, expect, it } from "vitest";
import {
  readStockVoicePick,
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
  };
}

describe("stock voice pick", () => {
  it("round-trips an explicit standard or expressive pick", () => {
    const storage = memoryStore();
    writeStockVoicePick(
      { catalogVoiceId: "ava", delivery: "standard" },
      storage
    );
    expect(readStockVoicePick(storage)).toEqual({
      catalogVoiceId: "ava",
      delivery: "standard",
    });
    writeStockVoicePick(
      { catalogVoiceId: "randolph", delivery: "expressive" },
      storage
    );
    expect(readStockVoicePick(storage)?.delivery).toBe("expressive");
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

  it("keeps an explicit pick ahead of the narrator suggestion", () => {
    const availableIds = ["standard", "ava", "clara", "randolph"];
    expect(
      resolveStockSelection({
        availableIds,
        explicitId: "randolph",
        suggestedId: "standard",
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
    ).toBe("standard");
  });
});
