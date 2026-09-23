import { z } from "zod";
import rawVoices from "./voices.json";
import type { CatalogVoice, StockProvider } from "@/lib/tts/types";
import { fetchOpenRouterCatalogVoices } from "./openrouter-catalog";
import { isHdVoice } from "@/lib/tts/premium";
import { isAllowedCatalogVoice } from "./allowlist";
import {
  enrichCatalogVoices,
  type EnrichedCatalogVoice,
} from "@/lib/tts/voice-persona";
import { getResearchPreviewVoice } from "@/lib/tts/research-preview";
import {
  cloneRowIdFromCatalogId,
  clonedVoiceToCatalog,
  isFishCloneCatalogId,
} from "@/lib/tts/fish-clone";
import { getClonedVoiceForUser } from "@/lib/turso/cloned-voices";
import { SLIM_STOCK_VOICE_IDS } from "@/lib/tts/standard-voice";

const catalogVoiceSchema = z.object({
  id: z.string(),
  provider: z.enum([
    "google",
    "grok",
    "gemini",
    "openrouter",
    "fish",
    "edge",
    "research",
  ]),
  providerVoiceId: z.string(),
  displayName: z.string(),
  language: z.string(),
  locale: z.string(),
  gender: z.enum(["female", "male", "neutral"]),
  style: z.string(),
  tags: z.array(z.string()),
  latencyClass: z.enum(["fast", "balanced", "quality"]),
  model: z.string(),
  recommendedForLongForm: z.boolean(),
  supportsNativeStream: z.boolean(),
  maxCharsPerRequest: z.number(),
  qualityNotes: z.string().optional(),
  stylePrompt: z.string().optional(),
  accentHint: z
    .enum(["american", "british", "australian", "irish", "other"])
    .optional(),
  usdPerMillionChars: z.number().optional(),
  usdPerAudioHour: z.number().optional(),
});

const staticVoices: CatalogVoice[] = z
  .array(catalogVoiceSchema)
  .parse(rawVoices);

/** App default stock narrator — Standard (en-US-AndrewNeural). */
export const DEFAULT_VOICE_ID = "standard";
/** Legacy slim-catalog id. Still resolved for in-flight jobs. */
export const FISH_NARRATOR_VOICE_ID = "fish-narrator";

type CatalogVoiceFilters = {
  provider?: StockProvider | string;
  language?: string;
  gender?: string;
  q?: string;
  hdEnabled?: boolean;
};

type CatalogVoiceAccess = {
  hdEnabled?: boolean;
  /** Required to resolve `clone:…` ids (user-scoped). */
  userId?: string | null;
};

function isVoiceAvailable(voice: CatalogVoice, hdEnabled = false): boolean {
  return hdEnabled || !isHdVoice(voice);
}

export function listStaticCatalogVoices(
  filters?: CatalogVoiceFilters
): CatalogVoice[] {
  return applyFilters(staticVoices, filters);
}

/**
 * Product catalog is four stock narrators + user clones:
 *   - Standard (`standard` → en-US-AndrewNeural, default; Expressive is opt-in)
 *   - Michelle (`michelle` → en-US-MichelleNeural; Expressive is opt-in)
 *   - Clara (`clara` → curated Fish reference)
 *   - Randolph (`randolph` → en-GB-Neural2-O, Google Cloud TTS; Expressive is opt-in)
 *   - Plus user clones merged in `/api/tts/voices` when `FISH_API_KEY` is set
 *
 * Gemini / MiniMax / Fish stock presets are not listed. getCatalogVoice still
 * resolves legacy `fish-narrator` / `or:` / `research:` / `gemini-*` ids for
 * in-flight jobs.
 */
function listSlimDefaultCatalogVoices(): CatalogVoice[] {
  return SLIM_STOCK_VOICE_IDS.map((id) =>
    staticVoices.find((v) => v.id === id)
  ).filter((v): v is CatalogVoice => Boolean(v));
}

function applyFilters(
  voices: CatalogVoice[],
  filters?: CatalogVoiceFilters
): CatalogVoice[] {
  let result = voices.filter(
    (voice) =>
      isAllowedCatalogVoice(voice) &&
      (voice.provider === "research" ||
        voice.provider === "fish" ||
        voice.provider === "edge" ||
        isVoiceAvailable(voice, filters?.hdEnabled))
  );
  if (filters?.provider) {
    const p = filters.provider.toLowerCase();
    if (p === "openrouter") {
      result = result.filter((v) => v.provider === "openrouter");
    } else if (
      p === "google" ||
      p === "grok" ||
      p === "gemini" ||
      p === "fish" ||
      p === "edge" ||
      p === "research"
    ) {
      result = result.filter((v) => v.provider === p);
    } else {
      result = result.filter(
        (v) =>
          v.model.toLowerCase().startsWith(`${p}/`) ||
          v.tags.some((t) => t.toLowerCase() === p)
      );
    }
  }
  if (filters?.language) {
    const lang = filters.language.toLowerCase();
    result = result.filter(
      (v) =>
        v.language.toLowerCase().includes(lang) ||
        v.locale.toLowerCase().includes(lang)
    );
  }
  if (filters?.gender) {
    result = result.filter((v) => v.gender === filters.gender);
  }
  if (filters?.q) {
    const q = filters.q.toLowerCase();
    result = result.filter(
      (v) =>
        v.displayName.toLowerCase().includes(q) ||
        v.tags.some((t) => t.includes(q)) ||
        v.style.toLowerCase().includes(q) ||
        v.providerVoiceId.toLowerCase().includes(q) ||
        v.locale.toLowerCase().includes(q) ||
        v.model.toLowerCase().includes(q) ||
        (v.qualityNotes?.toLowerCase().includes(q) ?? false)
    );
  }
  return result;
}

/** Slim catalog (Standard, Michelle, Clara, Randolph). Clones are merged at the voices API. */
export async function listCatalogVoices(
  filters?: CatalogVoiceFilters
): Promise<EnrichedCatalogVoice[]> {
  return enrichCatalogVoices(
    applyFilters(listSlimDefaultCatalogVoices(), filters)
  );
}

export async function getCatalogVoice(
  id: string,
  access?: CatalogVoiceAccess
): Promise<CatalogVoice | undefined> {
  if (id.startsWith("research:")) {
    return getResearchPreviewVoice(id);
  }
  if (isFishCloneCatalogId(id)) {
    const rowId = cloneRowIdFromCatalogId(id);
    if (!rowId || !access?.userId) return undefined;
    const row = await getClonedVoiceForUser(access.userId, rowId);
    return row ? clonedVoiceToCatalog(row) : undefined;
  }
  if (id === FISH_NARRATOR_VOICE_ID || id.startsWith("or:fish-audio/")) {
    const fish = staticVoices.find((v) => v.id === FISH_NARRATOR_VOICE_ID);
    if (fish && id === FISH_NARRATOR_VOICE_ID) {
      return publishCatalogVoice(fish);
    }
  }
  if (id.startsWith("or:")) {
    try {
      const live = await fetchOpenRouterCatalogVoices();
      const hit = live.find((v) => v.id === id);
      if (
        hit &&
        isAllowedCatalogVoice(hit) &&
        isVoiceAvailable(hit, access?.hdEnabled)
      ) {
        return publishCatalogVoice(hit);
      }
    } catch {
      /* fall through */
    }
  }
  const voice = staticVoices.find((v) => v.id === id);
  if (
    !voice ||
    !isAllowedCatalogVoice(voice) ||
    !isVoiceAvailable(voice, access?.hdEnabled)
  ) {
    return undefined;
  }
  return publishCatalogVoice(voice);
}

function publishCatalogVoice(voice: CatalogVoice): EnrichedCatalogVoice {
  // Baseline card only. Expressive resolves at job create and preview.
  return enrichCatalogVoices([voice])[0]!;
}

export function getCatalogVoiceSync(
  id: string,
  access?: CatalogVoiceAccess
): CatalogVoice | undefined {
  const voice = staticVoices.find((v) => v.id === id);
  if (!voice || !isVoiceAvailable(voice, access?.hdEnabled)) return undefined;
  return publishCatalogVoice(voice);
}

export function getCatalogVoiceByProviderId(
  provider: StockProvider,
  providerVoiceId: string,
  access?: CatalogVoiceAccess
): CatalogVoice | undefined {
  const voice = staticVoices.find(
    (v) => v.provider === provider && v.providerVoiceId === providerVoiceId
  );
  if (!voice || !isVoiceAvailable(voice, access?.hdEnabled)) return undefined;
  // Lookup key is the baseline provider id. Do not swap in a Fish twin
  // or the returned card would no longer match the query.
  return enrichCatalogVoices([voice])[0];
}

/** Fallback narrator when a request names no voice — always Standard. */
export function getDefaultCatalogVoice(): CatalogVoice {
  const standard = staticVoices.find((v) => v.id === DEFAULT_VOICE_ID);
  if (standard) return publishCatalogVoice(standard);
  const base = staticVoices[0]!;
  return publishCatalogVoice(base);
}

export { staticVoices as ALL_CATALOG_VOICES };
