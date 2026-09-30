/**
 * Explicit Standard-pile choice, kept across the upload/paste step.
 * An auto-highlight is not a pick — only a tap is written.
 */

import { coercePlainCatalogVoiceId } from "@/lib/tts/standard-voice";

const STORAGE_KEY = "ec_stock_voice_pick";

export type RememberedStockPick = {
  catalogVoiceId: string;
  delivery: "standard";
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
    // Michelle left the pile. An Expressive suffix follows the plain voice.
    let catalogVoiceId = coercePlainCatalogVoiceId(parsed.catalogVoiceId);
    if (catalogVoiceId === "michelle") catalogVoiceId = "ava";
    return { catalogVoiceId, delivery: "standard" };
  } catch {
    return null;
  }
}

export function writeStockVoicePick(
  pick: RememberedStockPick,
  storage: KeyValueStore | null = browserStorage()
): void {
  let catalogVoiceId = coercePlainCatalogVoiceId(pick.catalogVoiceId);
  if (catalogVoiceId === "michelle") catalogVoiceId = "ava";
  storage?.setItem(
    STORAGE_KEY,
    JSON.stringify({
      catalogVoiceId,
      delivery: "standard",
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
