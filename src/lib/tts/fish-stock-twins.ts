/**
 * Fish-native twins for the Standard slots (Andrew / Michelle / Randolph).
 *
 * The customer-facing ids stay `standard`, `michelle`, and `randolph`.
 * Production keeps Edge (Andrew, Michelle) and Google (Randolph) until BOTH
 * of these are true for that slot:
 *
 *   1. A rights-clear Fish `reference_id` is wired (baked below, or
 *      `FISH_TWIN_<SLOT>_REF`).
 *   2. The quality gate is open (`FISH_TWIN_<SLOT>=1`), which means a
 *      side-by-side listen against the current provider has passed.
 *
 * Do not runtime-clone Edge or Google output into Fish. Clara's reference
 * is a different US female and is not a Michelle twin. Shauna is a clone
 * test fixture, not a stock reference. No preview WAV/MP3 for these three
 * slots lives in the repo.
 *
 * When a twin is live, catalog resolution publishes provider `fish` and the
 * reference id. Whole book then takes the same DeepSeek cue-tag path as
 * Clara and user clones (`tts_provider = fish`). In-flight jobs that were
 * stored as `edge` / `google` stay on that provider.
 */

import type { CatalogVoice } from "@/lib/tts/types";
import {
  ANDREW_NEURAL_VOICE_ID,
  MICHELLE_CATALOG_VOICE_ID,
  MICHELLE_NEURAL_VOICE_ID,
  RANDOLPH_CATALOG_VOICE_ID,
  RANDOLPH_GOOGLE_VOICE_ID,
  STANDARD_CATALOG_VOICE_ID,
  STANDARD_MODEL,
  MICHELLE_MODEL,
  RANDOLPH_MODEL,
} from "@/lib/tts/standard-voice";

/** Hosted Fish S2 model. Same native id Clara and clones use. */
export const FISH_TWIN_MODEL = "s2.1-pro-free";

/**
 * Passage for the ears gate. Longer than the picker one-liner so pause,
 * dialogue, and a heading are actually audible. Speak the same text on the
 * baseline provider and on the Fish twin before opening a gate.
 */
export const FISH_TWIN_QUALITY_PASSAGE = [
  "Chapter One",
  "",
  "The harbor was quiet after the rain. Margaret closed the ledger, listened to the clock, and said, \"We leave at dawn — if the tide allows.\"",
  "",
  "He did not answer at once. Outside, a cart wheel struck a stone. Then he nodded. \"Tell the crew. And don't wake the boy.\"",
].join("\n");

/** Fish account model ids are 32 hex characters (Clara's shape). */
const FISH_MODEL_REFERENCE_RE = /^[a-f0-9]{32}$/i;

export type FishStockTwinId = "standard" | "michelle" | "randolph";

export type FishTwinBaseline = {
  provider: "edge" | "google";
  providerVoiceId: string;
  model: string;
};

export type FishStockTwinDefinition = {
  catalogId: FishStockTwinId;
  displayName: string;
  /**
   * Baked account reference. Empty until a rights-clear model exists on
   * the same Fish account as Clara. Env `FISH_TWIN_*_REF` overrides this.
   */
  fishReferenceId: string;
  locale: string;
  gender: "female" | "male";
  accentHint: "american" | "british";
  baseline: FishTwinBaseline;
  /** This change's ears result. Routing still needs the env gate. */
  recommendation: "hold" | "ship";
  /** Why the slot stays on the baseline in this change. */
  holdReason: string;
  /**
   * Where a future reference may come from. Not wired, not auditioned
   * against the baseline in this change.
   */
  candidateSource: string;
};

export const FISH_TWIN_GATE_ENV: Record<FishStockTwinId, string> = {
  standard: "FISH_TWIN_STANDARD",
  michelle: "FISH_TWIN_MICHELLE",
  randolph: "FISH_TWIN_RANDOLPH",
};

export const FISH_TWIN_REF_ENV: Record<FishStockTwinId, string> = {
  standard: "FISH_TWIN_STANDARD_REF",
  michelle: "FISH_TWIN_MICHELLE_REF",
  randolph: "FISH_TWIN_RANDOLPH_REF",
};

export const FISH_STOCK_TWINS: readonly FishStockTwinDefinition[] = [
  {
    catalogId: STANDARD_CATALOG_VOICE_ID,
    displayName: "Standard",
    fishReferenceId: "",
    locale: "en-US",
    gender: "male",
    accentHint: "american",
    baseline: {
      provider: "edge",
      providerVoiceId: ANDREW_NEURAL_VOICE_ID,
      model: STANDARD_MODEL,
    },
    recommendation: "hold",
    holdReason:
      "No rights-clear US male reference is in the repo, and no side-by-side listen against Edge Andrew Neural has passed. Do not clone Edge output.",
    candidateSource:
      "LibriVox public-domain reading by Mark Nelson (US male), reader catalog https://librivox.org/reader/251. A dry solo chapter to clip (10–180s): The Time Machine, chapter 1, https://librivox.org/the-time-machine-v3-by-h-g-wells/. LibriVox releases reader performances into the public domain. Home-recorded LibriVox audio often loses to Andrew Neural — audition, do not assume it ships.",
  },
  {
    catalogId: MICHELLE_CATALOG_VOICE_ID,
    displayName: "Michelle",
    fishReferenceId: "",
    locale: "en-US",
    gender: "female",
    accentHint: "american",
    baseline: {
      provider: "edge",
      providerVoiceId: MICHELLE_NEURAL_VOICE_ID,
      model: MICHELLE_MODEL,
    },
    recommendation: "hold",
    holdReason:
      "No rights-clear US female reference is wired for Michelle. Clara is a separate Fish stock slot and must not be reused as this twin.",
    candidateSource:
      "LibriVox public-domain reading by Kara Shallenberg (US female), reader catalog https://librivox.org/reader/19. A solo project to clip: The Secret Garden, https://librivox.org/the-secret-garden-by-frances-hodgson-burnett/. Same public-domain dedication as other LibriVox readings. Not auditioned against Edge Michelle Neural.",
  },
  {
    catalogId: RANDOLPH_CATALOG_VOICE_ID,
    displayName: "Randolph",
    fishReferenceId: "",
    locale: "en-GB",
    gender: "male",
    accentHint: "british",
    baseline: {
      provider: "google",
      providerVoiceId: RANDOLPH_GOOGLE_VOICE_ID,
      model: RANDOLPH_MODEL,
    },
    recommendation: "hold",
    holdReason:
      "No rights-clear British male reference is wired, and no side-by-side listen against Google en-GB-Neural2-O has passed.",
    candidateSource:
      "LibriVox public-domain reading by David Barnes (British male), reader catalog https://librivox.org/reader/94. A short solo to clip: Miscellaneous Pieces (Bunyan), https://librivox.org/miscellaneous-pieces-by-john-bunyan/. Not auditioned against Randolph.",
  },
];

const TWINS_BY_ID = new Map(
  FISH_STOCK_TWINS.map((twin) => [twin.catalogId, twin])
);

export function isFishStockTwinCatalogId(
  id?: string | null
): id is FishStockTwinId {
  return Boolean(id && TWINS_BY_ID.has(id as FishStockTwinId));
}

export function fishStockTwinDefinition(
  id?: string | null
): FishStockTwinDefinition | undefined {
  if (!isFishStockTwinCatalogId(id)) return undefined;
  return TWINS_BY_ID.get(id);
}

/** Accept only a Fish account model id. Neural ids and OpenRouter UUIDs are rejected. */
export function normalizeFishModelReferenceId(
  raw?: string | null
): string | null {
  const id = raw?.trim().toLowerCase() ?? "";
  if (!FISH_MODEL_REFERENCE_RE.test(id)) return null;
  return id;
}

export function fishTwinGateOpen(id: FishStockTwinId): boolean {
  const raw = process.env[FISH_TWIN_GATE_ENV[id]]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Reference that would be used if the gate is open.
 * Env override wins over the baked id so a bad model can be replaced
 * without a code change. Invalid strings are ignored.
 */
export function wiredFishTwinReferenceId(id: FishStockTwinId): string | null {
  const twin = TWINS_BY_ID.get(id);
  if (!twin) return null;
  const override = normalizeFishModelReferenceId(
    process.env[FISH_TWIN_REF_ENV[id]]
  );
  if (override) return override;
  return normalizeFishModelReferenceId(twin.fishReferenceId);
}

export type ActiveFishStockTwin = FishStockTwinDefinition & {
  fishReferenceId: string;
};

/**
 * Live twin: valid reference AND quality-gate env. Otherwise null — callers
 * keep the Edge / Google catalog card.
 */
export function activeFishStockTwin(
  id?: string | null
): ActiveFishStockTwin | null {
  if (!isFishStockTwinCatalogId(id)) return null;
  const twin = TWINS_BY_ID.get(id);
  if (!twin) return null;
  const fishReferenceId = wiredFishTwinReferenceId(id);
  if (!fishReferenceId) return null;
  if (!fishTwinGateOpen(id)) return null;
  return { ...twin, fishReferenceId };
}

/**
 * Job-create lock for the three Standard slots.
 * A live twin forces Fish. A held twin forces the Edge / Google baseline.
 * Caller-supplied provider ids cannot bypass the gate.
 */
export function lockedStockTwinVoice(catalog: {
  id?: string | null;
  provider?: string | null;
  providerVoiceId?: string | null;
  model?: string | null;
} | null | undefined): {
  provider: string;
  providerVoiceId: string;
  model: string;
} | null {
  if (!catalog || !isFishStockTwinCatalogId(catalog.id)) return null;
  const twin = TWINS_BY_ID.get(catalog.id);
  if (!twin) return null;
  if (fishTwinOwnsCatalogVoice(catalog)) {
    return {
      provider: "fish",
      providerVoiceId: catalog.providerVoiceId || "",
      model: catalog.model || FISH_TWIN_MODEL,
    };
  }
  return {
    provider: twin.baseline.provider,
    providerVoiceId: twin.baseline.providerVoiceId,
    model: twin.baseline.model,
  };
}

/** Published catalog card is the Fish twin (gate open and reference wired). */
export function fishTwinOwnsCatalogVoice(voice: {
  id?: string | null;
  provider?: string | null;
} | null | undefined): boolean {
  return Boolean(
    voice && isFishStockTwinCatalogId(voice.id) && voice.provider === "fish"
  );
}

/**
 * Swap a baseline card onto Fish when that slot's twin is live.
 * Display name, locale, and gender stay so the picker does not change.
 */
export function applyFishStockTwin<T extends CatalogVoice>(voice: T): T {
  const active = activeFishStockTwin(voice.id);
  if (!active) return voice;
  const tags = voice.tags.filter(
    (tag) => tag !== "edge" && tag !== "google" && tag !== "free"
  );
  return {
    ...voice,
    provider: "fish",
    providerVoiceId: active.fishReferenceId,
    model: FISH_TWIN_MODEL,
    maxCharsPerRequest: 8000,
    supportsNativeStream: true,
    usdPerMillionChars: 0,
    tags: Array.from(new Set([...tags, "stock", "fish-audio", "fish-twin"])),
    qualityNotes: `${active.displayName} stock narrator via a curated Fish reference. Live listen and Whole book use Fish cue markup. Needs FISH_API_KEY on the account that owns the model.`,
  };
}

export class FishStockTwinReferenceError extends Error {
  constructor(catalogVoiceId: string) {
    super(
      `Fish stock twin "${catalogVoiceId}" needs a 32-character Fish reference id. Refusing to synthesize on Fish's default voice.`
    );
    this.name = "FishStockTwinReferenceError";
  }
}

export type FishTwinRoutingReport = {
  catalogId: FishStockTwinId;
  displayName: string;
  recommendation: "hold" | "ship";
  routing: "baseline" | "fish";
  baselineProvider: "edge" | "google";
  baselineVoiceId: string;
  referenceId: string | null;
  gateOpen: boolean;
  holdReason: string;
  candidateSource: string;
};

export function fishStockTwinReport(): FishTwinRoutingReport[] {
  return FISH_STOCK_TWINS.map((twin) => {
    const active = activeFishStockTwin(twin.catalogId);
    return {
      catalogId: twin.catalogId,
      displayName: twin.displayName,
      recommendation: twin.recommendation,
      routing: active ? "fish" : "baseline",
      baselineProvider: twin.baseline.provider,
      baselineVoiceId: twin.baseline.providerVoiceId,
      referenceId: active?.fishReferenceId ?? wiredFishTwinReferenceId(twin.catalogId),
      gateOpen: fishTwinGateOpen(twin.catalogId),
      holdReason: twin.holdReason,
      candidateSource: twin.candidateSource,
    };
  });
}
