import { z } from "zod";
import rawVoices from "./voices.json";
import type { CatalogVoice, StockProvider } from "@/lib/tts/types";
import { fetchOpenRouterCatalogVoices } from "./openrouter-catalog";
import { getOpenRouterApiKey } from "@/lib/tts/providers/openrouter";
import { isHdVoice } from "@/lib/tts/premium";

const catalogVoiceSchema = z.object({
  id: z.string(),
  provider: z.enum(["google", "grok", "gemini", "openrouter"]),
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
  usdPerMillionChars: z.number().optional(),
  usdPerAudioHour: z.number().optional(),
});

const staticVoices: CatalogVoice[] = z
  .array(catalogVoiceSchema)
  .parse(rawVoices);

type CatalogVoiceFilters = {
  provider?: StockProvider | string;
  language?: string;
  gender?: string;
  q?: string;
  hdEnabled?: boolean;
};

type CatalogVoiceAccess = {
  hdEnabled?: boolean;
};

function isVoiceAvailable(voice: CatalogVoice, hdEnabled = false): boolean {
  return hdEnabled || !isHdVoice(voice);
}

export function listStaticCatalogVoices(
  filters?: CatalogVoiceFilters
): CatalogVoice[] {
  return applyFilters(staticVoices, filters);
}

function applyFilters(
  voices: CatalogVoice[],
  filters?: CatalogVoiceFilters
): CatalogVoice[] {
  let result = voices.filter((voice) =>
    isVoiceAvailable(voice, filters?.hdEnabled)
  );
  if (filters?.provider) {
    // "openrouter" or vendor slug like "openai" via tags
    const p = filters.provider.toLowerCase();
    if (p === "openrouter") {
      result = result.filter((v) => v.provider === "openrouter");
    } else if (p === "google" || p === "grok" || p === "gemini") {
      result = result.filter((v) => v.provider === p);
    } else {
      // vendor filter e.g. openai, microsoft, deepgram
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

/**
 * Live catalog: OpenRouter speech models when key (or public list) works;
 * falls back to static curated voices.
 */
export async function listCatalogVoices(
  filters?: CatalogVoiceFilters
): Promise<CatalogVoice[]> {
  // Prefer live OpenRouter speech catalog (models list is public; key needed to synth)
  try {
    const live = await fetchOpenRouterCatalogVoices();
    if (live.length > 0) {
      return applyFilters(live, filters);
    }
  } catch (err) {
    console.warn("[catalog] OpenRouter fetch failed, using static:", err);
  }
  return applyFilters(staticVoices, filters);
}

export async function getCatalogVoice(
  id: string,
  access?: CatalogVoiceAccess
): Promise<CatalogVoice | undefined> {
  if (id.startsWith("or:")) {
    try {
      const live = await fetchOpenRouterCatalogVoices();
      const hit = live.find((v) => v.id === id);
      if (hit && isVoiceAvailable(hit, access?.hdEnabled)) return hit;
    } catch {
      /* fall through */
    }
  }
  const voice = staticVoices.find((v) => v.id === id);
  return voice && isVoiceAvailable(voice, access?.hdEnabled)
    ? voice
    : undefined;
}

export function getCatalogVoiceSync(
  id: string,
  access?: CatalogVoiceAccess
): CatalogVoice | undefined {
  const voice = staticVoices.find((v) => v.id === id);
  return voice && isVoiceAvailable(voice, access?.hdEnabled)
    ? voice
    : undefined;
}

export function getCatalogVoiceByProviderId(
  provider: StockProvider,
  providerVoiceId: string,
  access?: CatalogVoiceAccess
): CatalogVoice | undefined {
  const voice = staticVoices.find(
    (v) => v.provider === provider && v.providerVoiceId === providerVoiceId
  );
  return voice && isVoiceAvailable(voice, access?.hdEnabled)
    ? voice
    : undefined;
}

export function getDefaultCatalogVoice(): CatalogVoice {
  return (
    staticVoices.find((v) => v.id === "google-wavenet-en-us-d") ||
    staticVoices.find((v) => v.id === "grok-eve") ||
    staticVoices[0]!
  );
}

export { staticVoices as ALL_CATALOG_VOICES };
