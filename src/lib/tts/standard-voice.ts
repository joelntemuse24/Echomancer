/**
 * Stock narrators shown in the slim catalog.
 *
 *   Standard  → Edge `en-US-AndrewNeural` (default)
 *   Michelle  → Edge `en-US-MichelleNeural`
 *   Clara     → Fish curated clone (`a50f1ee074124ba2b1dc44623f99abbe`)
 *   Randolph  → Google Cloud `en-GB-Neural2-O` (Jan 2025 successor of B)
 *
 * Customer UI uses these product names only — never raw vendor ids.
 * User clones stay on the Fish `clone:<uuid>` path.
 */

import {
  CLARA_CATALOG_VOICE_ID,
  CLARA_FISH_REFERENCE_ID,
  curatedFishDisplayName,
} from "@/lib/tts/curated-fish-stock";

export const STANDARD_CATALOG_VOICE_ID = "standard";
export const MICHELLE_CATALOG_VOICE_ID = "michelle";
export const RANDOLPH_CATALOG_VOICE_ID = "randolph";
export { CLARA_CATALOG_VOICE_ID, CLARA_FISH_REFERENCE_ID };

/**
 * Edge females Joel auditioned and rejected. Do not add these to the
 * slim catalog. Michelle is the only Edge female he marked usable.
 */
export const REJECTED_EDGE_FEMALE_LABELS = [
  "Ava",
  "Libby",
  "Jenny",
  "Emma",
  "Sonia",
  "Aria",
] as const;

/** Slim picker order: default first, then females, then Randolph. */
export const SLIM_STOCK_VOICE_IDS = [
  STANDARD_CATALOG_VOICE_ID,
  MICHELLE_CATALOG_VOICE_ID,
  CLARA_CATALOG_VOICE_ID,
  RANDOLPH_CATALOG_VOICE_ID,
] as const;

export const ANDREW_NEURAL_VOICE_ID = "en-US-AndrewNeural";
export const MICHELLE_NEURAL_VOICE_ID = "en-US-MichelleNeural";
/**
 * Current Google Cloud British male Neural2. `en-GB-Neural2-B` (and D)
 * remapped to O in the Jan 2025 EU voice update.
 */
export const RANDOLPH_GOOGLE_VOICE_ID = "en-GB-Neural2-O";
/** Retired id still accepted so in-flight jobs / EU auto-map keep working. */
export const RANDOLPH_GOOGLE_VOICE_ID_LEGACY = "en-GB-Neural2-B";

export const STANDARD_MODEL = `edge/${ANDREW_NEURAL_VOICE_ID}`;
export const MICHELLE_MODEL = `edge/${MICHELLE_NEURAL_VOICE_ID}`;
export const RANDOLPH_MODEL = `google/${RANDOLPH_GOOGLE_VOICE_ID}`;

/** Legacy slim-catalog id — still resolved for in-flight jobs. */
export const FISH_NARRATOR_VOICE_ID = "fish-narrator";

export const STOCK_DISPLAY_NAMES = {
  [STANDARD_CATALOG_VOICE_ID]: "Standard",
  [MICHELLE_CATALOG_VOICE_ID]: "Michelle",
  [CLARA_CATALOG_VOICE_ID]: "Clara",
  [RANDOLPH_CATALOG_VOICE_ID]: "Randolph",
} as const;

export type SlimStockVoiceId = (typeof SLIM_STOCK_VOICE_IDS)[number];

type VoiceHint = {
  id?: string | null;
  provider?: string | null;
  providerVoiceId?: string | null;
  model?: string | null;
};

function haystack(voice: VoiceHint): string {
  return `${voice.id || ""} ${voice.providerVoiceId || ""} ${voice.model || ""}`.toLowerCase();
}

export function isStandardCatalogId(id?: string | null): boolean {
  return id === STANDARD_CATALOG_VOICE_ID;
}

export function stockDisplayName(id?: string | null): string | null {
  if (!id) return null;
  return (
    (STOCK_DISPLAY_NAMES as Record<string, string>)[id] ??
    curatedFishDisplayName(id)
  );
}

/** Default US male only — Michelle / Clara / Randolph are not Standard. */
export function isStandardVoice(voice: VoiceHint): boolean {
  if (isStandardCatalogId(voice.id)) return true;
  if (voice.providerVoiceId === ANDREW_NEURAL_VOICE_ID) return true;
  const model = (voice.model || "").toLowerCase();
  return model.includes("en-us-andrewneural");
}

export function isMichelleVoice(voice: VoiceHint): boolean {
  if (voice.id === MICHELLE_CATALOG_VOICE_ID) return true;
  if (voice.providerVoiceId === MICHELLE_NEURAL_VOICE_ID) return true;
  return haystack(voice).includes("en-us-michelleneural");
}

export function isRandolphVoice(voice: VoiceHint): boolean {
  if (voice.id === RANDOLPH_CATALOG_VOICE_ID) return true;
  if (
    voice.providerVoiceId === RANDOLPH_GOOGLE_VOICE_ID ||
    voice.providerVoiceId === RANDOLPH_GOOGLE_VOICE_ID_LEGACY
  ) {
    return true;
  }
  const hay = haystack(voice);
  return hay.includes("en-gb-neural2-o") || hay.includes("en-gb-neural2-b");
}

/** Andrew / Michelle — free Edge Read Aloud path. */
export function isEdgeStockVoice(voice: VoiceHint): boolean {
  if (isStandardVoice(voice) || isMichelleVoice(voice)) return true;
  if (voice.provider === "edge") return true;
  return (voice.model || "").toLowerCase().startsWith("edge/");
}

export function isSlimStockVoiceId(id?: string | null): boolean {
  return Boolean(id && (SLIM_STOCK_VOICE_IDS as readonly string[]).includes(id));
}

export type EdgeBrowserTarget = {
  shortName: string;
  locale: string;
  neuralId: string;
};

/** Browser Web Speech match for an Edge stock voice. Clara / Randolph skip this. */
export function edgeBrowserTarget(voice: VoiceHint): EdgeBrowserTarget | null {
  if (isMichelleVoice(voice)) {
    return {
      shortName: "Michelle",
      locale: "en-US",
      neuralId: MICHELLE_NEURAL_VOICE_ID,
    };
  }
  if (isStandardVoice(voice) || isEdgeStockVoice(voice)) {
    return {
      shortName: "Andrew",
      locale: "en-US",
      neuralId: ANDREW_NEURAL_VOICE_ID,
    };
  }
  return null;
}
