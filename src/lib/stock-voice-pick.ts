/**
 * Explicit Standard-pile choice, kept across the upload/paste step.
 * An auto-highlight is not a pick — only a tap is written.
 */

import { GEORGE_CATALOG_VOICE_ID } from "@/lib/tts/george-voice";
import { HEART_CATALOG_VOICE_ID } from "@/lib/tts/heart-voice";
import { DREW_CATALOG_VOICE_ID } from "@/lib/tts/drew-voice";
import { SOWELL_CATALOG_VOICE_ID } from "@/lib/tts/sowell-id";
import { coercePlainCatalogVoiceId } from "@/lib/tts/standard-voice";

const STORAGE_KEY = "ec_stock_voice_pick";

export type RememberedStockPick = {
  catalogVoiceId: string;
  delivery: "standard";
};

type KeyValueStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
};

function isCloneCatalogId(id: string): boolean {
  return id.startsWith("clone:");
}

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
    // Andrew and Echomancer Andrew land on Drew. Ava, Libby, Clara, and
    // Michelle keep their ids here; the catalog response decides whether
    // they highlight Esther. `coerce` does the Drew rewrite.
    // A clone id is stored as itself and checked against this person's list
    // before it is selected.
    const catalogVoiceId = isCloneCatalogId(parsed.catalogVoiceId)
      ? parsed.catalogVoiceId
      : coerceRememberedStockId(parsed.catalogVoiceId);
    return { catalogVoiceId, delivery: "standard" };
  } catch {
    return null;
  }
}

export function writeStockVoicePick(
  pick: RememberedStockPick,
  storage: KeyValueStore | null = browserStorage()
): void {
  const catalogVoiceId = isCloneCatalogId(pick.catalogVoiceId)
    ? pick.catalogVoiceId
    : coerceRememberedStockId(pick.catalogVoiceId);
  storage?.setItem(
    STORAGE_KEY,
    JSON.stringify({
      catalogVoiceId,
      delivery: "standard",
    })
  );
}

export function clearStockVoicePick(
  storage: KeyValueStore | null = browserStorage()
): void {
  if (!storage) return;
  if (storage.removeItem) storage.removeItem(STORAGE_KEY);
  else storage.setItem(STORAGE_KEY, "");
}

function coerceRememberedStockId(id: string): string {
  return coercePlainCatalogVoiceId(id);
}

const ESTHER_PREDECESSOR_IDS = new Set([
  "ava",
  "libby",
  "clara",
  "michelle",
  HEART_CATALOG_VOICE_ID,
]);

/**
 * Map a saved pick or a suggestion onto a card the voices response actually
 * includes. Esther replaces Ava and Libby only while her card is present.
 * While Ava is still listed, a heart suggestion or a saved Esther pick
 * highlights Ava, and Clara stays on Libby.
 */
export function listedCatalogVoiceId(
  id: string | null | undefined,
  availableIds: readonly string[]
): string | null | undefined {
  if (!id) return id;
  const available = new Set(availableIds);
  if (available.has(id)) return id;
  if (ESTHER_PREDECESSOR_IDS.has(id) && available.has(HEART_CATALOG_VOICE_ID)) {
    return HEART_CATALOG_VOICE_ID;
  }
  if (id === "clara" && available.has("libby")) return "libby";
  if (
    (id === HEART_CATALOG_VOICE_ID ||
      id === "ava" ||
      id === "libby" ||
      id === "michelle") &&
    available.has("ava") &&
    !available.has(HEART_CATALOG_VOICE_ID)
  ) {
    return "ava";
  }
  return id;
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
  const explicitId = listedCatalogVoiceId(input.explicitId, input.availableIds);
  const suggestedId = listedCatalogVoiceId(input.suggestedId, input.availableIds);
  const available = new Set(input.availableIds);
  if (explicitId && available.has(explicitId)) return explicitId;
  // A saved Walter, Esther, George, or Drew pick stays theirs. When that
  // card is gone and no predecessor is listed, Drew is not substituted.
  if (
    explicitId === SOWELL_CATALOG_VOICE_ID ||
    explicitId === GEORGE_CATALOG_VOICE_ID ||
    explicitId === HEART_CATALOG_VOICE_ID ||
    explicitId === DREW_CATALOG_VOICE_ID
  ) {
    return null;
  }
  if (suggestedId && available.has(suggestedId)) {
    return suggestedId;
  }
  return input.availableIds[0] ?? null;
}

/**
 * Apply a saved voice once the catalog has loaded.
 * A clone id is kept only when it is in this person's clone list. While the
 * list is still loading, or the list request failed, the saved clone is not
 * selected and is not dropped. An empty list counts only after a successful
 * load. A deleted clone is cleared so it cannot stay selected through the reload.
 */
export function rememberedCloneOnRestore(input: {
  selectedId: string | null;
  rememberedId: string | null;
  cloneIds: readonly string[];
  loaded: boolean;
  /** `/api/tts/voices` failed. An empty `cloneIds` is not proof the clone is gone. */
  loadFailed?: boolean;
}): {
  selectedId: string | null;
  rememberedId: string | null;
  dropRemembered: boolean;
  clearTouched: boolean;
} {
  if (!input.loaded || input.loadFailed) {
    return {
      selectedId: input.selectedId,
      rememberedId: input.rememberedId,
      dropRemembered: false,
      clearTouched: false,
    };
  }
  const rememberedIsClone = Boolean(
    input.rememberedId && isCloneCatalogId(input.rememberedId)
  );
  const rememberedPresent =
    rememberedIsClone && input.cloneIds.includes(input.rememberedId!);
  const dropRemembered = rememberedIsClone && !rememberedPresent;
  const rememberedId = dropRemembered ? null : input.rememberedId;
  const selectedIsMissingClone = Boolean(
    input.selectedId &&
      isCloneCatalogId(input.selectedId) &&
      !input.cloneIds.includes(input.selectedId)
  );
  let selectedId = selectedIsMissingClone ? null : input.selectedId;
  if (
    rememberedPresent &&
    (selectedId == null || selectedId === input.rememberedId)
  ) {
    selectedId = input.rememberedId;
  }
  return {
    selectedId,
    rememberedId,
    dropRemembered,
    clearTouched: selectedIsMissingClone,
  };
}
