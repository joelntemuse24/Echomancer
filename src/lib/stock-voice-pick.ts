/**
 * Explicit Standard-pile choice, kept across the upload/paste step.
 * An auto-highlight is not a pick — only a tap is written.
 */

import { GEORGE_CATALOG_VOICE_ID } from "@/lib/tts/george-voice";
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
    // Michelle left the pile for Ava. Clara left it for Libby. Andrew is
    // retired, so a saved "standard" pick lands on Drew — `coerce` does that.
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
  let catalogVoiceId = coercePlainCatalogVoiceId(id);
  if (catalogVoiceId === "michelle") catalogVoiceId = "ava";
  return catalogVoiceId;
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
  // A saved Walter or George pick stays theirs. When the endpoint is off the
  // card is gone, and Drew is not substituted for it.
  if (
    input.explicitId === SOWELL_CATALOG_VOICE_ID ||
    input.explicitId === GEORGE_CATALOG_VOICE_ID ||
    input.explicitId === DREW_CATALOG_VOICE_ID
  ) {
    return null;
  }
  if (input.suggestedId && available.has(input.suggestedId)) {
    return input.suggestedId;
  }
  return input.availableIds[0] ?? null;
}

/**
 * Apply a saved voice once the catalog has loaded.
 * A clone id is kept only when it is in this person's clone list. While the
 * list is still loading the saved clone is not selected and is not dropped.
 * A deleted clone is cleared so it cannot stay selected through the reload.
 */
export function rememberedCloneOnRestore(input: {
  selectedId: string | null;
  rememberedId: string | null;
  cloneIds: readonly string[];
  loaded: boolean;
}): {
  selectedId: string | null;
  rememberedId: string | null;
  dropRemembered: boolean;
  clearTouched: boolean;
} {
  if (!input.loaded) {
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
