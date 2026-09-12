/**
 * Curated Fish stock voices — account-scoped `reference_id`s that we ship
 * as first-class picker cards (not user clones).
 *
 * Add a row here + a matching `voices.json` card to register another
 * Librivox / Archive.org narrator. Do not invent Edge females.
 */

export type CuratedFishStockVoice = {
  catalogId: string;
  displayName: string;
  fishReferenceId: string;
  locale: string;
  gender: "female" | "male" | "neutral";
  accentHint: "american" | "british" | "australian" | "irish" | "other";
};

export const CLARA_CATALOG_VOICE_ID = "clara";
export const CLARA_FISH_REFERENCE_ID = "a50f1ee074124ba2b1dc44623f99abbe";

export const CURATED_FISH_STOCK_VOICES: readonly CuratedFishStockVoice[] = [
  {
    catalogId: CLARA_CATALOG_VOICE_ID,
    displayName: "Clara",
    fishReferenceId: CLARA_FISH_REFERENCE_ID,
    locale: "en-US",
    gender: "female",
    accentHint: "american",
  },
];

export const CURATED_FISH_STOCK_IDS = CURATED_FISH_STOCK_VOICES.map(
  (v) => v.catalogId
);

const REFERENCE_IDS = new Set(
  CURATED_FISH_STOCK_VOICES.map((v) => v.fishReferenceId)
);
const CATALOG_IDS = new Set(CURATED_FISH_STOCK_IDS);

export function isCuratedFishStockVoice(voice: {
  id?: string | null;
  providerVoiceId?: string | null;
  catalogVoiceId?: string | null;
}): boolean {
  const id = voice.id || voice.catalogVoiceId;
  if (id && CATALOG_IDS.has(id)) return true;
  const ref = voice.providerVoiceId;
  return Boolean(ref && REFERENCE_IDS.has(ref));
}

export function curatedFishDisplayName(id?: string | null): string | null {
  if (!id) return null;
  return CURATED_FISH_STOCK_VOICES.find((v) => v.catalogId === id)?.displayName ?? null;
}
