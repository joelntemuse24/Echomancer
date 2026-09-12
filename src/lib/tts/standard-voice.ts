/**
 * Stock narrators shown in the slim catalog.
 *
 *   Standard  → Edge `en-US-AndrewNeural` (default)
 *   Ava       → Edge `en-US-AvaNeural`
 *   Libby     → Edge `en-GB-LibbyNeural`
 *   Randolph  → Google Cloud `en-GB-Neural2-O` (Jan 2025 successor of B)
 *
 * Customer UI uses these product names only — never raw vendor ids.
 * Clones stay on the Fish path.
 */

export const STANDARD_CATALOG_VOICE_ID = "standard";
export const AVA_CATALOG_VOICE_ID = "ava";
export const LIBBY_CATALOG_VOICE_ID = "libby";
export const RANDOLPH_CATALOG_VOICE_ID = "randolph";

/** Slim picker order: default first, then the two females, then Randolph. */
export const SLIM_STOCK_VOICE_IDS = [
  STANDARD_CATALOG_VOICE_ID,
  AVA_CATALOG_VOICE_ID,
  LIBBY_CATALOG_VOICE_ID,
  RANDOLPH_CATALOG_VOICE_ID,
] as const;

export const ANDREW_NEURAL_VOICE_ID = "en-US-AndrewNeural";
export const AVA_NEURAL_VOICE_ID = "en-US-AvaNeural";
export const LIBBY_NEURAL_VOICE_ID = "en-GB-LibbyNeural";
/**
 * Current Google Cloud British male Neural2. `en-GB-Neural2-B` (and D)
 * remapped to O in the Jan 2025 EU voice update.
 */
export const RANDOLPH_GOOGLE_VOICE_ID = "en-GB-Neural2-O";
/** Retired id still accepted so in-flight jobs / EU auto-map keep working. */
export const RANDOLPH_GOOGLE_VOICE_ID_LEGACY = "en-GB-Neural2-B";

export const STANDARD_MODEL = `edge/${ANDREW_NEURAL_VOICE_ID}`;
export const AVA_MODEL = `edge/${AVA_NEURAL_VOICE_ID}`;
export const LIBBY_MODEL = `edge/${LIBBY_NEURAL_VOICE_ID}`;
export const RANDOLPH_MODEL = `google/${RANDOLPH_GOOGLE_VOICE_ID}`;

/** Legacy slim-catalog id — still resolved for in-flight jobs. */
export const FISH_NARRATOR_VOICE_ID = "fish-narrator";

export const STOCK_DISPLAY_NAMES = {
  [STANDARD_CATALOG_VOICE_ID]: "Standard",
  [AVA_CATALOG_VOICE_ID]: "Ava",
  [LIBBY_CATALOG_VOICE_ID]: "Libby",
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
  return (STOCK_DISPLAY_NAMES as Record<string, string>)[id] ?? null;
}

/** Default US male only — Ava / Libby / Randolph are not Standard. */
export function isStandardVoice(voice: VoiceHint): boolean {
  if (isStandardCatalogId(voice.id)) return true;
  if (voice.providerVoiceId === ANDREW_NEURAL_VOICE_ID) return true;
  const model = (voice.model || "").toLowerCase();
  return model.includes("en-us-andrewneural");
}

export function isAvaVoice(voice: VoiceHint): boolean {
  if (voice.id === AVA_CATALOG_VOICE_ID) return true;
  if (voice.providerVoiceId === AVA_NEURAL_VOICE_ID) return true;
  return haystack(voice).includes("en-us-avaneural");
}

export function isLibbyVoice(voice: VoiceHint): boolean {
  if (voice.id === LIBBY_CATALOG_VOICE_ID) return true;
  if (voice.providerVoiceId === LIBBY_NEURAL_VOICE_ID) return true;
  return haystack(voice).includes("en-gb-libbyneural");
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

/** Andrew / Ava / Libby — free Edge Read Aloud path. */
export function isEdgeStockVoice(voice: VoiceHint): boolean {
  if (isStandardVoice(voice) || isAvaVoice(voice) || isLibbyVoice(voice)) {
    return true;
  }
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

/** Browser Web Speech match for an Edge stock voice. Randolph is Google-only. */
export function edgeBrowserTarget(voice: VoiceHint): EdgeBrowserTarget | null {
  if (isAvaVoice(voice)) {
    return { shortName: "Ava", locale: "en-US", neuralId: AVA_NEURAL_VOICE_ID };
  }
  if (isLibbyVoice(voice)) {
    return { shortName: "Libby", locale: "en-GB", neuralId: LIBBY_NEURAL_VOICE_ID };
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
