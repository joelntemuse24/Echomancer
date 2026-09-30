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
      { catalogVoiceId: "michelle", delivery: "standard" },
      storage
    );
    expect(readStockVoicePick(storage)).toEqual({
      catalogVoiceId: "michelle",
      delivery: "standard",
    });
    writeStockVoicePick(
      { catalogVoiceId: "randolph", delivery: "expressive" },
      storage
    );
    expect(readStockVoicePick(storage)?.delivery).toBe("expressive");
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
    const availableIds = ["standard", "michelle", "clara", "randolph"];
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
        suggestedId: "michelle",
      })
    ).toBe("michelle");
    expect(
      resolveStockSelection({
        availableIds,
        explicitId: null,
        suggestedId: null,
      })
    ).toBe("standard");
  });
});
