/**
 * Explicit Standard-pile choice, kept across the upload/paste step.
 * An auto-highlight is not a pick — only a tap is written.
 */

const STORAGE_KEY = "ec_stock_voice_pick";

export type RememberedStockPick = {
  catalogVoiceId: string;
  delivery: "standard" | "expressive";
};

type KeyValueStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function browserStorage(): KeyValueStore | null {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

export function readStockVoicePick(
  storage: KeyValueStore | null = browserStorage()
): RememberedStockPick | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RememberedStockPick>;
    if (typeof parsed.catalogVoiceId !== "string" || !parsed.catalogVoiceId) {
      return null;
    }
    // Michelle left the pile. A saved pick follows Ava, on standard delivery.
    const catalogVoiceId =
      parsed.catalogVoiceId === "michelle" ? "ava" : parsed.catalogVoiceId;
    const delivery =
      catalogVoiceId === "ava"
        ? "standard"
        : parsed.delivery === "expressive"
          ? "expressive"
          : "standard";
    return { catalogVoiceId, delivery };
  } catch {
    return null;
  }
}

export function writeStockVoicePick(
  pick: RememberedStockPick,
  storage: KeyValueStore | null = browserStorage()
): void {
  storage?.setItem(
    STORAGE_KEY,
    JSON.stringify({
      catalogVoiceId: pick.catalogVoiceId,
      delivery: pick.delivery === "expressive" ? "expressive" : "standard",
    })
  );
}

/**
 * Stock row to highlight once the catalog is loaded.
 * An explicit pick wins over the narrator suggestion.
 */
export function resolveStockSelection(input: {
  availableIds: readonly string[];
  explicitId?: string | null;
  suggestedId?: string | null;
}): string | null {
  const available = new Set(input.availableIds);
  if (input.explicitId && available.has(input.explicitId)) return input.explicitId;
  if (input.suggestedId && available.has(input.suggestedId)) {
    return input.suggestedId;
  }
  return input.availableIds[0] ?? null;
}
