import { isCuratedFishStockVoice } from "@/lib/tts/curated-fish-stock";
import { GEORGE_CATALOG_VOICE_ID } from "@/lib/tts/george-voice";
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
 * Walter is remembered only by its own id. It is not one of the five slim ids.
 */
export function isListedGeorgeVoice(voice: PathVoice): boolean {
  return voice.id === GEORGE_CATALOG_VOICE_ID && voice.provider === "george";
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
 * Walter's sample is a static file. Play is a separate control from the
 * selection, and a tap on play does not ask the server to synthesize.
 */
export function stockCardAudition(
  voice: PathVoice
): "play" | "select-only" | "static" {
  return isListedWalterVoice(voice) ? "static" : "play";
}

/**
 * Standard = slim stock in picker order, then Walter when the server listed it.
 *
 * A listed card must come from the provider that speaks it. Drew and George
 * are on the Kokoro CPU app, so an `edge` row carrying their id is not that
 * voice and is dropped — the same rule Walter already had. The provider check
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

export function withVoicePathParam(
  params: string | URLSearchParams,
  path: VoicePath | null
): URLSearchParams {
  const next = new URLSearchParams(params);
  if (path) next.set("path", path);
  else next.delete("path");
  return next;
}
