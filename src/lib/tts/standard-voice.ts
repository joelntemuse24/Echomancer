/**
 * Product default stock voice: Microsoft neural `en-US-AndrewNeural`,
 * shown as **Standard**. Clones stay on the Fish path.
 */

export const STANDARD_CATALOG_VOICE_ID = "standard";
export const ANDREW_NEURAL_VOICE_ID = "en-US-AndrewNeural";
export const STANDARD_MODEL = "edge/en-US-AndrewNeural";
/** Legacy slim-catalog id — still resolved for in-flight jobs. */
export const FISH_NARRATOR_VOICE_ID = "fish-narrator";

export function isStandardCatalogId(id?: string | null): boolean {
  return id === STANDARD_CATALOG_VOICE_ID;
}

export function isStandardVoice(voice: {
  id?: string | null;
  provider?: string | null;
  providerVoiceId?: string | null;
  model?: string | null;
}): boolean {
  if (isStandardCatalogId(voice.id)) return true;
  if (voice.provider === "edge") return true;
  if (voice.providerVoiceId === ANDREW_NEURAL_VOICE_ID) return true;
  const model = (voice.model || "").toLowerCase();
  return model.includes("en-us-andrewneural") || model.startsWith("edge/");
}
