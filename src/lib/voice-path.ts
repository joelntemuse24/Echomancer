import { isCuratedFishStockVoice } from "@/lib/tts/curated-fish-stock";
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

/** The server included Sowell. A same id on another provider is not this voice. */
export function isListedSowellVoice(voice: PathVoice): boolean {
  return voice.id === SOWELL_CATALOG_VOICE_ID && voice.provider === "sowell";
}

/**
 * A tap on the standard pile that should survive the upload step.
 * Sowell is remembered only by its own id. It is not one of the five slim ids.
 */
export function isPersistableStandardVoiceId(id?: string | null): boolean {
  return isSlimStockVoiceId(id) || id === SOWELL_CATALOG_VOICE_ID;
}

/**
 * Sowell has no committed sample. The card selects the voice and does not
 * ask the server to synthesize one.
 */
export function stockCardAudition(voice: PathVoice): "play" | "select-only" {
  return isListedSowellVoice(voice) ? "select-only" : "play";
}

/** Standard = slim stock in picker order, then Sowell when the server listed it. */
export function voicesForPath<T extends PathVoice>(
  voices: T[],
  path: VoicePath
): T[] {
  if (path === "standard") {
    const byId = new Map(voices.map((voice) => [voice.id, voice]));
    const slim = SLIM_STOCK_VOICE_IDS.map((id) => byId.get(id)).filter(
      (voice): voice is T => Boolean(voice)
    );
    const sowell = voices.find((voice) => isListedSowellVoice(voice));
    return sowell ? [...slim, sowell] : slim;
  }
  return voices.filter((voice) => isUserCloneVoice(voice));
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
