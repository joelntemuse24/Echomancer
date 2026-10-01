/**
 * Stock narrators shown in the slim catalog.
 *
 *   Andrew    → Edge `en-US-AndrewNeural` (catalog id `standard`)
 *   Ava       → Edge `en-US-AvaNeural` (non-HD; Dragon HD is not on this route)
 *   Libby     → Edge `en-GB-LibbyNeural`
 *   Ryan      → Edge `en-GB-RyanNeural`
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
export const AVA_CATALOG_VOICE_ID = "ava";
export const LIBBY_CATALOG_VOICE_ID = "libby";
export const RYAN_CATALOG_VOICE_ID = "ryan";
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

/** Slim picker order: Andrew, Ava, Libby, Ryan. */
export const SLIM_STOCK_VOICE_IDS = [
  STANDARD_CATALOG_VOICE_ID,
  AVA_CATALOG_VOICE_ID,
  LIBBY_CATALOG_VOICE_ID,
  RYAN_CATALOG_VOICE_ID,
] as const;

export const ANDREW_NEURAL_VOICE_ID = "en-US-AndrewNeural";
export const AVA_NEURAL_VOICE_ID = "en-US-AvaNeural";
export const LIBBY_NEURAL_VOICE_ID = "en-GB-LibbyNeural";
export const RYAN_NEURAL_VOICE_ID = "en-GB-RyanNeural";
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
  [AVA_CATALOG_VOICE_ID]: "Ava",
  [LIBBY_CATALOG_VOICE_ID]: "Libby",
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

/** Default US male only — Ava / Libby / Ryan are not Standard. */
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
 * Andrew / Ava / Libby / Ryan — free Edge Read Aloud path. Legacy Michelle too.
 * A row already stored as Fish stays on Fish.
 */
export function isEdgeStockVoice(voice: VoiceHint): boolean {
  if (voice.provider === "fish") return false;
  if (
    isStandardVoice(voice) ||
    isAvaVoice(voice) ||
    isLibbyVoice(voice) ||
    isRyanVoice(voice) ||
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
  if (isRyanVoice(voice)) {
    return {
      shortName: "Ryan",
      locale: "en-GB",
      neuralId: RYAN_NEURAL_VOICE_ID,
    };
  }
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
  ryan: RYAN_CATALOG_VOICE_ID,
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

/** Listed stock plus legacy Michelle / Randolph. Not Clara, not a user clone. */
export function isBaselineStockCatalogId(id?: string | null): boolean {
  return (
    id === STANDARD_CATALOG_VOICE_ID ||
    id === AVA_CATALOG_VOICE_ID ||
    id === LIBBY_CATALOG_VOICE_ID ||
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
