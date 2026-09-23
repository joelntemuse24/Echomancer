/**
 * Fish-native twins for the Standard slots (Andrew / Michelle / Randolph).
 *
 * The customer-facing ids stay `standard`, `michelle`, and `randolph`.
 * The default choice stays on Edge (Andrew, Michelle) or Google (Randolph).
 * Expressive uses Fish only when BOTH of these are true for that slot:
 *
 *   1. A Fish `reference_id` is wired (baked below, or `FISH_TWIN_<SLOT>_REF`).
 *   2. The quality gate is open (`FISH_TWIN_<SLOT>=1`), which means a
 *      side-by-side listen against the current provider has passed.
 *      Andrew is the strict bar.
 *
 * The intended reference is a Fish clone of that slot's own Edge or Google
 * voice, using the same clone call as any other voice: `POST /model` with
 * `visibility=private` and `train_mode=fast`. Paste the returned 32-hex id
 * into the env ref (or bake it here once it exists). Ids stay empty until
 * that clone exists. Clara's reference is a different narrator, not
 * Michelle's twin. Shauna is a clone test fixture.
 *
 * The published catalog card stays on Edge or Google even when a twin is
 * live. Expressive is an explicit choice: only then does a job store
 * `tts_provider = fish` and take the same DeepSeek cue-tag path as Clara.
 * In-flight jobs stay on the provider already stored in the row.
 */

import type { CatalogVoice } from "@/lib/tts/types";
import type {
  ExpressiveOffer,
  StockDeliveryMode,
} from "@/lib/tts/stock-delivery";
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
   * Baked account reference. Empty until a Fish clone id is pasted in.
   * Env `FISH_TWIN_*_REF` overrides this.
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
   * How to produce the Fish model. Not wired until a real id is pasted,
   * and not auditioned against the baseline in this change.
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
      "No Fish reference id is wired yet, and the Edge Andrew clone has not passed a side-by-side listen against Edge en-US-AndrewNeural.",
    candidateSource:
      "Clone an Edge en-US-AndrewNeural sample with the same Fish flow as any other voice: POST /model, visibility private, train_mode fast. Paste the 32-hex model id into FISH_TWIN_STANDARD_REF, or bake it in fishReferenceId once it exists. Open FISH_TWIN_STANDARD only after the clone sounds as good or better than Edge Andrew.",
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
      "No Fish reference id is wired yet, and the Edge Michelle clone has not passed a side-by-side listen against Edge en-US-MichelleNeural. Clara's existing reference is a different narrator.",
    candidateSource:
      "Clone an Edge en-US-MichelleNeural sample with the same Fish flow as any other voice: POST /model, visibility private, train_mode fast. Paste the 32-hex model id into FISH_TWIN_MICHELLE_REF, or bake it in fishReferenceId once it exists. Clara's reference is a separate stock voice.",
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
      "No Fish reference id is wired yet, and the Google Randolph clone has not passed a side-by-side listen against Google en-GB-Neural2-O.",
    candidateSource:
      "Clone a Google en-GB-Neural2-O sample with the same Fish flow as any other voice: POST /model, visibility private, train_mode fast. Paste the 32-hex model id into FISH_TWIN_RANDOLPH_REF, or bake it in fishReferenceId once it exists.",
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

export type StockTwinResolution =
  | { status: "passthrough" }
  | {
      status: "locked";
      delivery: StockDeliveryMode;
      provider: string;
      providerVoiceId: string;
      model: string;
    }
  | {
      status: "rejected";
      code: "EXPRESSIVE_UNAVAILABLE" | "EXPRESSIVE_NOT_OFFERED";
    };

/**
 * Job-create lock for the three Standard slots.
 * Standard always stores the Edge / Google baseline, even when the gate is
 * open and even if the caller sends Fish. Expressive stores Fish only when
 * the reference and the quality gate are both set. Clara and clones pass
 * through. Caller-supplied provider ids cannot bypass the gate.
 */
export function resolveStockTwinLock(
  catalog: {
    id?: string | null;
    provider?: string | null;
    providerVoiceId?: string | null;
    model?: string | null;
  } | null | undefined,
  delivery: StockDeliveryMode = "standard"
): StockTwinResolution {
  if (!catalog || !isFishStockTwinCatalogId(catalog.id)) {
    if (delivery === "expressive") {
      return { status: "rejected", code: "EXPRESSIVE_NOT_OFFERED" };
    }
    return { status: "passthrough" };
  }
  const twin = TWINS_BY_ID.get(catalog.id);
  if (!twin) return { status: "passthrough" };
  if (delivery === "expressive") {
    const active = activeFishStockTwin(catalog.id);
    if (!active) return { status: "rejected", code: "EXPRESSIVE_UNAVAILABLE" };
    return {
      status: "locked",
      delivery: "expressive",
      provider: "fish",
      providerVoiceId: active.fishReferenceId,
      model: FISH_TWIN_MODEL,
    };
  }
  return {
    status: "locked",
    delivery: "standard",
    provider: twin.baseline.provider,
    providerVoiceId: twin.baseline.providerVoiceId,
    model: twin.baseline.model,
  };
}

/**
 * Picker offer for a catalog id. Null for Clara, clones, and anything else.
 * Booleans only — the Fish reference id stays on the server.
 */
export function expressiveOfferForVoice(
  id?: string | null
): ExpressiveOffer | null {
  if (!isFishStockTwinCatalogId(id)) return null;
  const configured = wiredFishTwinReferenceId(id) != null;
  return {
    configured,
    available: activeFishStockTwin(id) != null,
  };
}

/**
 * Fish card for an explicit Expressive synthesis. The published catalog does
 * not call this — Standard stays on Edge / Google until the user picks
 * Expressive and the twin is live.
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
