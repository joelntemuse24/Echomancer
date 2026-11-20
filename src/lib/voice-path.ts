import { resolveStockSelection } from "@/lib/stock-voice-pick";
import { isCuratedFishStockVoice } from "@/lib/tts/curated-fish-stock";
import { GEORGE_CATALOG_VOICE_ID } from "@/lib/tts/george-voice";
import { HEART_CATALOG_VOICE_ID } from "@/lib/tts/heart-voice";
import { DREW_CATALOG_VOICE_ID } from "@/lib/tts/drew-voice";
import { SOWELL_CATALOG_VOICE_ID } from "@/lib/tts/sowell-id";
import {
  isBaselineStockCatalogId,
  isSlimStockVoiceId,
  SLIM_STOCK_VOICE_IDS,
} from "@/lib/tts/standard-voice";

/** First voice-step choice after intake. Not a catalog. */
export type VoicePath = "standard" | "clone";

export function parseVoicePath(
  raw: string | null | undefined
): VoicePath | null {
  if (raw === "standard" || raw === "clone") return raw;
  return null;
}

type PathVoice = {
  id: string;
  provider?: string | null;
  providerVoiceId?: string | null;
  tags?: string[] | null;
};

/** Client-safe clone check. Avoid the Fish clone adapter module (it pulls Turso). */
export function isUserCloneVoice(voice: PathVoice): boolean {
  if (isCuratedFishStockVoice(voice)) return false;
  if (isBaselineStockCatalogId(voice.id)) return false;
  if (voice.id.startsWith("clone:")) return true;
  if (voice.provider === "fish") return true;
  return Boolean(voice.tags?.some((t) => t.toLowerCase() === "cloned"));
}

/**
 * The server included Walter. A same id on another provider is not this voice.
 * The catalog id is still `sowell`; the listed name is Walter.
 */
export function isListedWalterVoice(voice: PathVoice): boolean {
  return voice.id === SOWELL_CATALOG_VOICE_ID && voice.provider === "sowell";
}

/** Back-compat alias for the pre-rename name. */
export const isListedSowellVoice = isListedWalterVoice;

/**
 * A tap on the standard pile that should survive the upload step.
 * Walter is remembered only by its own id. It is not one of the slim ids.
 */
export function isListedGeorgeVoice(voice: PathVoice): boolean {
  return voice.id === GEORGE_CATALOG_VOICE_ID && voice.provider === "george";
}

/** Heart is listed as one of the slim ids, but only when the server sent it. */
export function isListedHeartVoice(voice: PathVoice): boolean {
  return voice.id === HEART_CATALOG_VOICE_ID && voice.provider === "heart";
}

/** Drew is listed as one of the slim ids, but only when the server sent it. */
export function isListedDrewVoice(voice: PathVoice): boolean {
  return voice.id === DREW_CATALOG_VOICE_ID && voice.provider === "drew";
}

export function isPersistableStandardVoiceId(id?: string | null): boolean {
  return (
    isSlimStockVoiceId(id) ||
    id === SOWELL_CATALOG_VOICE_ID ||
    id === GEORGE_CATALOG_VOICE_ID
  );
}

/**
 * Every listed card is one control: previewing it selects it.
 * Walter's sample is still the committed file (`stockPreviewUrl`); that
 * does not give the row a second pressed state.
 */
export function stockCardAudition(
  voice: PathVoice
): "play" | "select-only" | "static" {
  void voice;
  return "play";
}

/**
 * Standard = slim stock in picker order, then Walter when the server listed it.
 *
 * A listed card must come from the provider that speaks it. Drew, Heart, and
 * George are on the Kokoro CPU app, so an `edge` row carrying their id is not
 * that voice and is dropped — the same rule Walter already had. The provider check
 * runs **before** the id map is built, so a stray row with a duplicated id
 * cannot mask the card the server actually sent.
 */
export function voicesForPath<T extends PathVoice>(
  voices: T[],
  path: VoicePath
): T[] {
  if (path === "standard") {
    const trusted = voices.filter((voice) => {
      if (voice.id === GEORGE_CATALOG_VOICE_ID) return isListedGeorgeVoice(voice);
      if (voice.id === HEART_CATALOG_VOICE_ID) return isListedHeartVoice(voice);
      if (voice.id === DREW_CATALOG_VOICE_ID) return isListedDrewVoice(voice);
      if (voice.id === SOWELL_CATALOG_VOICE_ID) return isListedWalterVoice(voice);
      return true;
    });
    const byId = new Map(trusted.map((voice) => [voice.id, voice]));
    const slim = SLIM_STOCK_VOICE_IDS.map((id) => byId.get(id)).filter(
      (voice): voice is T => Boolean(voice)
    );
    const walter = trusted.find((voice) => isListedWalterVoice(voice));
    return walter ? [...slim, walter] : slim;
  }
  return voices.filter((voice) => isUserCloneVoice(voice));
}

/**
 * Stock cards, then this person's clones. The clone panel still lists the
 * clones; the main list and the new-book step use this so a `clone:` voice
 * is selectable without opening that panel. A clone is never the default
 * highlight — that stays the first stock id.
 */
export function voicesForMainList<T extends PathVoice>(voices: T[]): T[] {
  const stock = voicesForPath(voices, "standard");
  const clones = voicesForPath(voices, "clone");
  const stockIds = new Set(stock.map((voice) => voice.id));
  return [...stock, ...clones.filter((voice) => !stockIds.has(voice.id))];
}

/**
 * Standard-path highlight. A chosen clone stays chosen. Stock auto-pick
 * still runs only over stock ids, so a suggestion cannot land on a clone
 * and a clone cannot become the default.
 */
export function selectionOnStandardPath(input: {
  selectedId: string | null;
  stockIds: readonly string[];
  cloneIds: readonly string[];
  explicitStockId?: string | null;
  suggestedId?: string | null;
  narratorTouched: boolean;
}): string | null {
  if (input.selectedId && input.cloneIds.includes(input.selectedId)) {
    return input.selectedId;
  }
  const explicitId = input.narratorTouched
    ? input.selectedId && input.stockIds.includes(input.selectedId)
      ? input.selectedId
      : input.explicitStockId
    : null;
  return resolveStockSelection({
    availableIds: input.stockIds,
    explicitId,
    suggestedId: input.suggestedId,
  });
}

export function withVoicePathParam(
  params: string | URLSearchParams,
  path: VoicePath | null
): URLSearchParams {
  const next = new URLSearchParams(params);
  if (path) next.set("path", path);
  else next.delete("path");
  return next;
}
