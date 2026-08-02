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

const catalogVoiceSchema = z.object({
  id: z.string(),
  provider: z.enum([
    "google",
    "grok",
    "gemini",
    "openrouter",
    "fish",
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

/** App default narrator — Fish Audio S2.1 Pro Free on OpenRouter. */
export const DEFAULT_VOICE_ID = "fish-narrator";

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
 * Product catalog is Fish Audio only:
 *   - Default Narrator (`fish-narrator`)
 *   - Plus user clones merged in `/api/tts/voices` when `FISH_API_KEY` is set
 *
 * Gemini / MiniMax / other presets are not listed. getCatalogVoice still
 * resolves legacy `or:` / `research:` / `gemini-*` ids for in-flight jobs.
 */
function listSlimDefaultCatalogVoices(): CatalogVoice[] {
  const fish = staticVoices.find((v) => v.id === DEFAULT_VOICE_ID);
  return fish ? [fish] : [];
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

/** Fish-only slim catalog (Narrator). Clones are merged at the voices API. */
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
  if (id === DEFAULT_VOICE_ID || id.startsWith("or:fish-audio/")) {
    const fish = staticVoices.find((v) => v.id === DEFAULT_VOICE_ID);
    if (fish && id === DEFAULT_VOICE_ID) {
      return enrichCatalogVoices([fish])[0];
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
        return enrichCatalogVoices([hit])[0];
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
  return enrichCatalogVoices([voice])[0];
}

export function getCatalogVoiceSync(
  id: string,
  access?: CatalogVoiceAccess
): CatalogVoice | undefined {
  const voice = staticVoices.find((v) => v.id === id);
  if (!voice || !isVoiceAvailable(voice, access?.hdEnabled)) return undefined;
  return enrichCatalogVoices([voice])[0];
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
  return enrichCatalogVoices([voice])[0];
}

/** Fallback narrator when a request names no voice — always Fish Narrator. */
export function getDefaultCatalogVoice(): CatalogVoice {
  const fish = staticVoices.find((v) => v.id === DEFAULT_VOICE_ID);
  if (fish) return enrichCatalogVoices([fish])[0]!;
  const base = staticVoices[0]!;
  return enrichCatalogVoices([base])[0]!;
}

export { staticVoices as ALL_CATALOG_VOICES };
