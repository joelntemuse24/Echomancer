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
import { AVA_CATALOG_VOICE_ID, SLIM_STOCK_VOICE_IDS } from "@/lib/tts/standard-voice";
import { GEORGE_CATALOG_VOICE_ID, georgeReady } from "@/lib/tts/george-voice";
import { SOWELL_CATALOG_VOICE_ID, sowellReady } from "@/lib/tts/sowell-voice";
import { DREW_CATALOG_VOICE_ID, drewReady } from "@/lib/tts/drew-voice";

const catalogVoiceSchema = z.object({
  id: z.string(),
  provider: z.enum([
    "google",
    "grok",
    "gemini",
    "openrouter",
    "fish",
    "edge",
    "paradee",
    "sowell",
    "george",
    "drew",
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

/** App default stock narrator — Drew (fine-tuned Kokoro-82M). */
export const DEFAULT_VOICE_ID = DREW_CATALOG_VOICE_ID;
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

/**
 * Product catalog is five stock narrators + user clones:
 *   - Drew (`drew`, the default, fine-tuned Kokoro-82M on the CPU app)
 *   - Echomancer Andrew (`echomancer-andrew` → self-hosted Paradee)
 *   - Ava (`ava` → en-US-AvaNeural)
 *   - Libby (`libby` → en-GB-LibbyNeural)
 *   - George (`george` → Kokoro `bm_george`, only when configured)
 *   - Plus Walter (`sowell`, Kokoro pack) when its endpoint is up
 *   - Plus user clones merged in `/api/tts/voices` when `FISH_API_KEY` is set
 *
 * Retired ids are not listed: Andrew (`standard`, Edge), Ryan, Michelle,
 * Clara, Randolph. `getCatalogVoice` still resolves each for a stored job.
 *
 * Gemini / MiniMax / Fish stock presets are not listed. getCatalogVoice still
 * resolves legacy `fish-narrator` / `or:` / `research:` / `gemini-*` ids for
 * in-flight jobs.
 */
function listSlimDefaultCatalogVoices(): CatalogVoice[] {
  const slim = SLIM_STOCK_VOICE_IDS.map((id) =>
    staticVoices.find((v) => v.id === id)
  ).filter((v): v is CatalogVoice => {
    if (!v) return false;
    if (v.id === GEORGE_CATALOG_VOICE_ID && !georgeReady()) return false;
    if (v.id === DREW_CATALOG_VOICE_ID && !drewReady()) return false;
    return true;
  });
  const walter = sowellReady()
    ? staticVoices.find((v) => v.id === SOWELL_CATALOG_VOICE_ID)
    : undefined;
  return walter ? [...slim, walter] : slim;
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
        voice.provider === "paradee" ||
        voice.provider === "sowell" ||
        voice.provider === "george" ||
        voice.provider === "drew" ||
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
      p === "paradee" ||
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

/** Slim catalog (Andrew, Ava, Libby, Ryan). Clones are merged at the voices API. */
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
  if (
    voice.id === SOWELL_CATALOG_VOICE_ID ||
    voice.id === GEORGE_CATALOG_VOICE_ID ||
    voice.id === DREW_CATALOG_VOICE_ID
  ) {
    const ready =
      voice.id === SOWELL_CATALOG_VOICE_ID
        ? sowellReady()
        : voice.id === GEORGE_CATALOG_VOICE_ID
          ? georgeReady()
          : drewReady();
    if (!ready) return undefined;
  }
  return publishCatalogVoice(voice);
}

function publishCatalogVoice(voice: CatalogVoice): EnrichedCatalogVoice {
  return enrichCatalogVoices([voice])[0]!;
}

/**
 * Fallback narrator when a request names no voice — Drew.
 *
 * Drew is the product default, but it lives on our own CPU app, so the card
 * (and this default) only exists while `DREW_ENABLED`, `DREW_URL` and
 * `DREW_TOKEN` are set. Before that deploy the fallback is Ava, the Edge voice
 * that needs no configuration: a no-voice request must never be stored
 * pointing at an endpoint that cannot speak.
 */
export function getDefaultCatalogVoice(): CatalogVoice {
  const preferred = drewReady()
    ? staticVoices.find((v) => v.id === DEFAULT_VOICE_ID)
    : staticVoices.find((v) => v.id === AVA_CATALOG_VOICE_ID);
  const chosen =
    preferred ?? staticVoices.find((v) => v.id === DEFAULT_VOICE_ID) ?? staticVoices[0]!;
  return publishCatalogVoice(chosen);
}
