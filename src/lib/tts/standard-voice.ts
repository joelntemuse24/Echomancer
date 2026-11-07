/**
 * Stock narrators shown in the slim catalog.
 *
 *   Andrew    → Edge `en-US-AndrewNeural` (catalog id `standard`)
 *   Ava       → Edge `en-US-AvaNeural` (non-HD; Dragon HD is not on this route)
 *   Libby     → Edge `en-GB-LibbyNeural`
 *   George    → Kokoro `bm_george` via OpenRouter (British male; replaced Ryan)
 *
 * Ryan (`ryan` → Edge `en-GB-RyanNeural`) is **no longer listed**. It was the
 * British male stock voice until 2026-11-07 and is replaced by George above.
 * The id stays resolvable so a book already made with Ryan keeps playing and
 * downloading its own audio: stored audio is never re-synthesized, and a stored
 * Ryan row is never served as George. A *new* request that names Ryan gets
 * George, because the product voice for that slot is now George. That is a
 * deliberate change of the new-book answer, not a rewrite of anything stored.
 *
 * Clara stays resolvable for books already made with her, and is not listed.
 * A new request or saved pick that names Clara uses Libby. One that names
 * Randolph or a Google Cloud voice uses Andrew. A book already stored as
 * Randolph keeps its audio and is not spoken again. Michelle
 * (`en-US-MichelleNeural`) is the same kind of unlisted id. Do not add
 * rejected Edge females (Jenny, Sonia, Aria) or Ava Dragon HD.
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
/**
 * Self-hosted Paradee student distilled from the Echomancer narrator. It is a
 * separate voice with its own provider, so it never resolves to Edge Standard.
 */
export const ECHOMANCER_ANDREW_CATALOG_VOICE_ID = "echomancer-andrew";
export const AVA_CATALOG_VOICE_ID = "ava";
export const LIBBY_CATALOG_VOICE_ID = "libby";
export const RYAN_CATALOG_VOICE_ID = "ryan";
/** Listed British male stock voice. Kokoro `bm_george` via OpenRouter. */
export const GEORGE_CATALOG_VOICE_ID = "george";
/** Not listed. Still resolved so an in-flight Michelle job can finish. */
export const MICHELLE_CATALOG_VOICE_ID = "michelle";
/** Old catalog id. New requests and saved picks use Andrew. */
export const RANDOLPH_CATALOG_VOICE_ID = "randolph";
export { CLARA_CATALOG_VOICE_ID, CLARA_FISH_REFERENCE_ID };

/**
 * Edge females auditioned and rejected. Ava (non-HD) replaced Michelle.
 * Libby is the listed UK female. Dragon HD Ava is a different voice and is
 * not on the free Edge route.
 */
export const REJECTED_EDGE_FEMALE_LABELS = [
  "Jenny",
  "Emma",
  "Sonia",
  "Aria",
] as const;

/** Auditioned but not approved — do not add to the slim picker. */
export const UNSHIPPED_STOCK_LABELS = ["Helen"] as const;

/** Slim picker order: Andrew, Echomancer Andrew, Ava, Libby, George. */
export const SLIM_STOCK_VOICE_IDS = [
  STANDARD_CATALOG_VOICE_ID,
  ECHOMANCER_ANDREW_CATALOG_VOICE_ID,
  AVA_CATALOG_VOICE_ID,
  LIBBY_CATALOG_VOICE_ID,
  GEORGE_CATALOG_VOICE_ID,
] as const;

export const ANDREW_NEURAL_VOICE_ID = "en-US-AndrewNeural";
export const AVA_NEURAL_VOICE_ID = "en-US-AvaNeural";
export const LIBBY_NEURAL_VOICE_ID = "en-GB-LibbyNeural";
/**
 * Edge's British male voice. No longer listed; still recognised so a stored
 * Ryan row keeps its own identity and its own audio.
 */
export const RYAN_NEURAL_VOICE_ID = "en-GB-RyanNeural";
/** Kokoro voice name for the listed British male narrator. */
export const GEORGE_KOKORO_VOICE_ID = "bm_george";
/** OpenRouter speech model that serves Kokoro voices. */
export const KOKORO_MODEL_ID = "hexgrad/kokoro-82m";
export const GEORGE_MODEL = KOKORO_MODEL_ID;
export const MICHELLE_NEURAL_VOICE_ID = "en-US-MichelleNeural";
/**
 * Retired Google Cloud ids. Stored jobs may still name them. New synthesis
 * does not call Google.
 */
export const RANDOLPH_GOOGLE_VOICE_ID = "en-GB-Neural2-O";
export const RANDOLPH_GOOGLE_VOICE_ID_LEGACY = "en-GB-Neural2-B";

export const STANDARD_MODEL = `edge/${ANDREW_NEURAL_VOICE_ID}`;
export const AVA_MODEL = `edge/${AVA_NEURAL_VOICE_ID}`;
export const LIBBY_MODEL = `edge/${LIBBY_NEURAL_VOICE_ID}`;
export const RYAN_MODEL = `edge/${RYAN_NEURAL_VOICE_ID}`;
export const MICHELLE_MODEL = `edge/${MICHELLE_NEURAL_VOICE_ID}`;

/** Legacy slim-catalog id — still resolved for in-flight jobs. */
export const FISH_NARRATOR_VOICE_ID = "fish-narrator";

export const STOCK_DISPLAY_NAMES = {
  [STANDARD_CATALOG_VOICE_ID]: "Andrew",
  [ECHOMANCER_ANDREW_CATALOG_VOICE_ID]: "Echomancer Andrew",
  [AVA_CATALOG_VOICE_ID]: "Ava",
  [LIBBY_CATALOG_VOICE_ID]: "Libby",
  [GEORGE_CATALOG_VOICE_ID]: "George",
  [RYAN_CATALOG_VOICE_ID]: "Ryan",
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

/**
 * The self-hosted Paradee student. Its own catalog id, provider and model
 * prefix all identify it, so it is never mistaken for the Edge `standard` row.
 */
export function isEchomancerAndrewVoice(voice: VoiceHint): boolean {
  if (voice.id === ECHOMANCER_ANDREW_CATALOG_VOICE_ID) return true;
  if ((voice.provider || "").toLowerCase() === "paradee") return true;
  return (voice.model || "").toLowerCase().startsWith("paradee/");
}

/** Default US male only — Ava / Libby / Ryan are not Standard. */
export function isStandardVoice(voice: VoiceHint): boolean {
  if (isEchomancerAndrewVoice(voice)) return false;
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
  if (voice.provider === "fish") return false;
  if (voice.id === LIBBY_CATALOG_VOICE_ID) return true;
  if (voice.providerVoiceId === LIBBY_NEURAL_VOICE_ID) return true;
  return haystack(voice).includes("en-gb-libbyneural");
}

export function isRyanVoice(voice: VoiceHint): boolean {
  if (voice.provider === "fish" || voice.provider === "google") return false;
  if (voice.id === RYAN_CATALOG_VOICE_ID) return true;
  if (voice.providerVoiceId === RYAN_NEURAL_VOICE_ID) return true;
  return haystack(voice).includes("en-gb-ryanneural");
}

/**
 * The listed British male voice: Kokoro `bm_george` served through OpenRouter.
 *
 * Matched on the catalog id, the provider voice id, or the model + voice pair,
 * so a stored row is recognised even if its catalog id is missing.
 */
export function isGeorgeVoice(voice: VoiceHint): boolean {
  if (voice.id === GEORGE_CATALOG_VOICE_ID) return true;
  if (voice.providerVoiceId === GEORGE_KOKORO_VOICE_ID) return true;
  const model = (voice.model || "").toLowerCase();
  return model.includes("kokoro") && haystack(voice).includes(GEORGE_KOKORO_VOICE_ID);
}

export function isMichelleVoice(voice: VoiceHint): boolean {
  if (voice.id === MICHELLE_CATALOG_VOICE_ID) return true;
  if (voice.providerVoiceId === MICHELLE_NEURAL_VOICE_ID) return true;
  return haystack(voice).includes("en-us-michelleneural");
}

export function isRandolphVoice(voice: VoiceHint): boolean {
  if (voice.provider === "fish") return false;
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

/**
 * Andrew / Ava / Libby — free Edge Read Aloud path. Legacy Michelle too.
 * A row already stored as Fish stays on Fish.
 *
 * Ryan is deliberately **not** here any more. It is unlisted and replaced by
 * George (Kokoro via OpenRouter), so a new request must not be routed to the
 * Edge British male voice under the product's British male slot. A book already
 * stored as `ryan` still has `provider: "edge"` on its row and keeps its own
 * audio untouched; nothing re-synthesizes it.
 */
export function isEdgeStockVoice(voice: VoiceHint): boolean {
  if (voice.provider === "fish") return false;
  if (isEchomancerAndrewVoice(voice)) return false;
  if (isGeorgeVoice(voice)) return false;
  if (
    isStandardVoice(voice) ||
    isAvaVoice(voice) ||
    isLibbyVoice(voice) ||
    isMichelleVoice(voice)
  ) {
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

/** Browser Web Speech match for an Edge stock voice. A stored Randolph row skips this. */
export function edgeBrowserTarget(voice: VoiceHint): EdgeBrowserTarget | null {
  if (voice.provider === "fish" || voice.provider === "google") return null;
  // Kokoro is server-side only: there is no browser voice to fall back to.
  if (isGeorgeVoice(voice)) return null;
  if (isLibbyVoice(voice)) {
    return {
      shortName: "Libby",
      locale: "en-GB",
      neuralId: LIBBY_NEURAL_VOICE_ID,
    };
  }
  if (isAvaVoice(voice)) {
    return {
      shortName: "Ava",
      locale: "en-US",
      neuralId: AVA_NEURAL_VOICE_ID,
    };
  }
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

const EXPRESSIVE_TAIL =
  /(?:\s*\(\s*expressive\s*\)|[-_:\s]+expressive)\s*$/i;

const PLAIN_ID_ALIASES: Record<string, string> = {
  andrew: STANDARD_CATALOG_VOICE_ID,
  ava: AVA_CATALOG_VOICE_ID,
  libby: LIBBY_CATALOG_VOICE_ID,
  clara: LIBBY_CATALOG_VOICE_ID,
  // Ryan is unlisted. A new request that names it gets the current British male
  // voice, George. This only runs for a NEW job request, so no stored book is
  // touched and no stored Ryan audio is ever re-synthesized or relabelled.
  ryan: GEORGE_CATALOG_VOICE_ID,
  george: GEORGE_CATALOG_VOICE_ID,
  randolph: STANDARD_CATALOG_VOICE_ID,
  michelle: MICHELLE_CATALOG_VOICE_ID,
  standard: STANDARD_CATALOG_VOICE_ID,
};

/**
 * Saved picks and new job requests that still name an Expressive variant
 * land on the matching plain stock id. A bare "expressive" is Andrew.
 * A request that still says Clara uses Libby. One that says Randolph uses
 * Andrew. Books already stored as Clara or Randolph are left alone.
 */
export function coercePlainCatalogVoiceId(raw: string): string {
  const stripped = raw.trim().replace(EXPRESSIVE_TAIL, "").trim();
  if (!stripped || /^expressive$/i.test(stripped)) {
    return STANDARD_CATALOG_VOICE_ID;
  }
  return PLAIN_ID_ALIASES[stripped.toLowerCase()] ?? stripped;
}

/** Listed stock plus legacy Ryan / Michelle / Randolph. Not Clara, not a clone. */
export function isBaselineStockCatalogId(id?: string | null): boolean {
  return (
    id === STANDARD_CATALOG_VOICE_ID ||
    id === ECHOMANCER_ANDREW_CATALOG_VOICE_ID ||
    id === AVA_CATALOG_VOICE_ID ||
    id === LIBBY_CATALOG_VOICE_ID ||
    id === GEORGE_CATALOG_VOICE_ID ||
    id === RYAN_CATALOG_VOICE_ID ||
    id === MICHELLE_CATALOG_VOICE_ID ||
    id === RANDOLPH_CATALOG_VOICE_ID
  );
}

export type PlainStockLock = {
  provider: "edge";
  providerVoiceId: string;
  model: string;
};

/** True for a stored Google Cloud row. New synthesis must not call that API. */
export function isRetiredGoogleSynthesis(input: {
  provider?: string | null;
  providerVoiceId?: string | null;
}): boolean {
  if ((input.provider || "").toLowerCase() === "google") return true;
  const voice = (input.providerVoiceId || "").toLowerCase();
  return (
    voice === RANDOLPH_GOOGLE_VOICE_ID.toLowerCase() ||
    voice === RANDOLPH_GOOGLE_VOICE_ID_LEGACY.toLowerCase()
  );
}

/** Edge card for a baseline stock id. Clara, Randolph, and clones are not locked. */
export function plainStockLock(id?: string | null): PlainStockLock | null {
  if (id === STANDARD_CATALOG_VOICE_ID) {
    return {
      provider: "edge",
      providerVoiceId: ANDREW_NEURAL_VOICE_ID,
      model: STANDARD_MODEL,
    };
  }
  if (id === AVA_CATALOG_VOICE_ID) {
    return {
      provider: "edge",
      providerVoiceId: AVA_NEURAL_VOICE_ID,
      model: AVA_MODEL,
    };
  }
  if (id === LIBBY_CATALOG_VOICE_ID) {
    return {
      provider: "edge",
      providerVoiceId: LIBBY_NEURAL_VOICE_ID,
      model: LIBBY_MODEL,
    };
  }
  if (id === RYAN_CATALOG_VOICE_ID) {
    return {
      provider: "edge",
      providerVoiceId: RYAN_NEURAL_VOICE_ID,
      model: RYAN_MODEL,
    };
  }
  if (id === MICHELLE_CATALOG_VOICE_ID) {
    return {
      provider: "edge",
      providerVoiceId: MICHELLE_NEURAL_VOICE_ID,
      model: MICHELLE_MODEL,
    };
  }
  return null;
}

/** Drop a leftover "(Expressive)" label from a stored or requested voice name. */
export function stripExpressiveLabel(name: string): string {
  return name.replace(/\s*\(\s*expressive\s*\)/gi, "").replace(/\s+/g, " ").trim();
}
