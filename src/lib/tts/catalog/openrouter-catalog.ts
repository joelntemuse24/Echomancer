/**
 * Expand OpenRouter speech models into catalog voice cards.
 * One catalog entry per (model × voice).
 *
 * Only curated vendors (Gemini, Qwen, Minimax, Microsoft, Grok) are expanded.
 */

import type { CatalogVoice } from "@/lib/tts/types";
import {
  listOpenRouterSpeechModels,
  type OpenRouterSpeechModel,
} from "@/lib/tts/providers/openrouter";
import { enrichCatalogVoice } from "@/lib/tts/voice-persona";
import {
  isAllowedSpeechModel,
  MINIMAX_SEEDED_VOICES,
} from "@/lib/tts/catalog/allowlist";
import {
  GEMINI_ACCENT_LOCALES,
  modelSupportsAccentVariants,
  narrationStylePrompt,
} from "@/lib/tts/accent-prompt";

/**
 * Known rates in USD per million characters, keyed by model-id substring.
 *
 * OpenRouter reports `pricing.prompt` as a per-unit price, but the unit differs
 * between speech models (characters for some, tokens for others) and is not
 * declared in the listing. A misread by a factor of four silently misquotes every
 * book, so a vendor rate we have confirmed always wins over the derived number.
 *
 * First match wins — put more specific substrings before vendor catch-alls.
 * Confirmed against OpenRouter model pages + MiniMax paygo (Jul 2026):
 *   MiniMax HD $100/M · Turbo $60/M · MAI-Voice-2 $22/M · Flash $15/M ·
 *   Qwen Flash $15/M · Plus $20/M · Grok Voice $15/M.
 * Re-check these whenever OpenRouter changes speech pricing.
 */
const PRICE_OVERRIDES_USD_PER_MILLION_CHARS: Array<{
  match: string;
  usdPerMillionChars: number;
}> = [
  { match: "speech-02-turbo", usdPerMillionChars: 60 },
  { match: "speech-2.6-turbo", usdPerMillionChars: 60 },
  { match: "speech-2.8-turbo", usdPerMillionChars: 60 },
  { match: "minimax", usdPerMillionChars: 100 },
  { match: "mai-voice-2-flash", usdPerMillionChars: 15 },
  { match: "microsoft", usdPerMillionChars: 22 },
  { match: "tts-plus", usdPerMillionChars: 20 },
  { match: "qwen", usdPerMillionChars: 15 },
  { match: "grok-voice", usdPerMillionChars: 15 },
];

/**
 * Plausibility window for a derived character rate. Real TTS sits between about
 * $0.50 and $500 per million characters; anything outside that means we read the
 * wrong unit and should fall back rather than quote it.
 */
const MIN_PLAUSIBLE_USD_PER_MILLION = 0.5;
const MAX_PLAUSIBLE_USD_PER_MILLION = 500;

export function usdPerMillionCharsForModel(
  modelId: string,
  pricingPrompt?: string
): number | undefined {
  const override = PRICE_OVERRIDES_USD_PER_MILLION_CHARS.find((entry) =>
    modelId.toLowerCase().includes(entry.match)
  );
  if (override) return override.usdPerMillionChars;

  if (!pricingPrompt) return undefined;
  const perUnit = Number(pricingPrompt);
  if (!Number.isFinite(perUnit) || perUnit <= 0) return undefined;

  const perMillion = Math.round(perUnit * 1_000_000 * 1000) / 1000;
  if (
    perMillion < MIN_PLAUSIBLE_USD_PER_MILLION ||
    perMillion > MAX_PLAUSIBLE_USD_PER_MILLION
  ) {
    console.warn(
      `[catalog] implausible rate for ${modelId}: $${perMillion}/M chars from pricing.prompt=${pricingPrompt} — falling back to the pricing default`
    );
    return undefined;
  }
  return perMillion;
}

function vendorFromId(id: string): string {
  return id.split("/")[0] || "openrouter";
}

function guessGender(voice: string): CatalogVoice["gender"] {
  const v = voice.toLowerCase();
  // Kokoro / similar: af_*, am_*, bf_*, bm_* (accent + gender)
  const kokoro = v.match(/^[a-z]?([fm])[_-]/);
  if (kokoro?.[1] === "f") return "female";
  if (kokoro?.[1] === "m") return "male";
  if (
    /female|woman|lady|girl|nova|shimmer|alloy|kore|aoede|eve|ara|harper|valeria|soleil|thalia|asteria|athena|luna|hera|selene|iris|ophelia|helena|cordelia|andromeda|amalthea|callista|delia|electra|harmonia|juno|minerva|pandora|phoebe|vesta|maia|livia|cinzia|demetra|melia|antonia|gloria|olivia|silvia|estrella|carina|celeste|diana|agathe|beatrix|cornelia|daphne|hestia|leda|rhea|aurelia|elara|kara|lara|viktoria|ama|izanami|uzume|emma|sky|bella|sarah|isabella|nicole|zephyr|callirrhoe|autonoe|despina|erinome|algenib|gacrux|pulcherrima|vindemiatrix|sulafat|laomedeia|achernar|schedar/.test(
      v
    )
  ) {
    return "female";
  }
  if (
    /male|man|bloke|gentleman|boy|echo|onyx|fable|puck|charon|fenrir|leo|rex|klaus|john|zeus|apollo|atlas|orion|orpheus|mars|saturn|pluto|neptune|hermes|janus|draco|hyperion|odysseus|arcas|aries|aquila|cesare|elio|flavio|dionisio|hector|fabian|julius|lars|roman|sander|javier|nestor|luciano|valerio|sirio|fujin|ebisu|george|lewis|michael|adam|orus|enceladus|iapetus|umbriel|algieba|rasalgethi|alnilam|zubenelgenubi|sadachbia|sadaltager|achird|sal\b/.test(
      v
    )
  ) {
    return "male";
  }
  return "neutral";
}

function guessLocale(voice: string): string {
  const v = voice.toLowerCase();
  const m = voice.match(/^([a-z]{2}-[A-Z]{2})/);
  if (m) return m[1]!;

  // Kokoro-style prefixes (harmless if those models are allowlisted out)
  if (/^b[fm][_-]/.test(v) || v.startsWith("british") || v.includes("british_")) {
    return "en-GB";
  }
  if (/^a[fm][_-]/.test(v) || v.startsWith("american") || v.includes("american_")) {
    return "en-US";
  }
  if (/^e[fm][_-]/.test(v)) return "en-GB";
  if (v.includes("australian") || v.includes("aussie") || /^au[_-]/.test(v)) {
    return "en-AU";
  }
  if (v.includes("irish") || /^ie[_-]/.test(v)) return "en-IE";

  if (voice.endsWith("-en") || /-en$/i.test(voice) || voice.includes("-en-"))
    return "en-US";
  if (voice.includes("-es") || voice.endsWith("-es") || v.startsWith("es-"))
    return "es-ES";
  if (voice.includes("-fr") || voice.endsWith("-fr") || v.startsWith("fr-"))
    return "fr-FR";
  if (voice.includes("-de") || voice.endsWith("-de") || v.startsWith("de-"))
    return "de-DE";
  if (voice.includes("-it") || voice.endsWith("-it")) return "it-IT";
  if (voice.includes("-nl") || voice.endsWith("-nl")) return "nl-NL";
  if (voice.includes("-ja") || voice.endsWith("-ja")) return "ja-JP";
  if (v.startsWith("long") || v.startsWith("loong")) return "zh-CN";
  return "en-US";
}

function languageFromLocale(locale: string): string {
  const map: Record<string, string> = {
    en: "English",
    es: "Spanish",
    fr: "French",
    de: "German",
    it: "Italian",
    nl: "Dutch",
    ja: "Japanese",
    pt: "Portuguese",
    zh: "Chinese",
  };
  return map[locale.slice(0, 2)] || locale;
}

function latencyClassForModel(
  modelId: string
): CatalogVoice["latencyClass"] {
  if (
    modelId.includes("flash") ||
    modelId.includes("turbo") ||
    modelId.includes("mini")
  ) {
    return "fast";
  }
  if (modelId.includes("hd") || modelId.includes("minimax")) {
    return "quality";
  }
  return "balanced";
}

function maxCharsForModel(modelId: string): number {
  const id = modelId.toLowerCase();
  // Larger safe chunks → fewer sections → faster wall clock for take-home
  if (id.includes("gemini") && (id.includes("flash") || id.includes("turbo"))) {
    return 4000;
  }
  if (id.includes("gemini")) return 3500;
  if (id.includes("minimax")) return 2800;
  if (id.includes("qwen")) return 2400;
  if (id.includes("microsoft")) return 2400;
  if (id.includes("grok") || id.includes("x-ai")) return 2400;
  return 2200;
}

function voiceIdsForModel(model: OpenRouterSpeechModel): string[] {
  if (model.supported_voices && model.supported_voices.length > 0) {
    return model.supported_voices;
  }
  // MiniMax: OR advertises empty voices but accepts system IDs
  if (model.id.toLowerCase().includes("minimax")) {
    return MINIMAX_SEEDED_VOICES.map((v) => v.id);
  }
  return [];
}

function expandModel(model: OpenRouterSpeechModel): CatalogVoice[] {
  if (!isAllowedSpeechModel(model.id)) return [];

  const voices = voiceIdsForModel(model);
  if (voices.length === 0) return [];

  const usdPerMillionChars = usdPerMillionCharsForModel(
    model.id,
    model.pricing?.prompt
  );
  const vendor = vendorFromId(model.id);
  const seeded = model.id.toLowerCase().includes("minimax")
    ? new Map(MINIMAX_SEEDED_VOICES.map((v) => [v.id, v]))
    : null;

  return voices.flatMap((voice) => {
    const seed = seeded?.get(voice);
    const baseLocale = seed?.locale || guessLocale(voice);
    const displayVoice =
      seed?.displayName ||
      (voice.includes(":")
        ? voice.split(":")[0] || voice
        : voice.replace(/^aura-2-/, "").replace(/-en$/, ""));

    const makeCard = (opts: {
      locale: string;
      idSuffix?: string;
      stylePrompt?: string;
      accentTag?: string;
    }): CatalogVoice => {
      const accentHint = opts.accentTag as CatalogVoice["accentHint"] | undefined;
      const base: CatalogVoice = {
        id: opts.idSuffix
          ? `or:${model.id}:${voice}:${opts.idSuffix}`
          : `or:${model.id}:${voice}`,
        provider: "openrouter" as const,
        providerVoiceId: voice,
        displayName: displayVoice,
        language: languageFromLocale(opts.locale),
        locale: opts.locale,
        gender: seed?.gender || guessGender(voice),
        style: seed?.style || "narration",
        tags: [
          vendor,
          "openrouter",
          "tts",
          ...(opts.accentTag ? [opts.accentTag] : []),
          ...(model.id.includes("minimax") || model.id.includes("hd")
            ? ["hd"]
            : []),
        ],
        latencyClass: latencyClassForModel(model.id),
        model: model.id,
        recommendedForLongForm: !model.id.includes("mini"),
        supportsNativeStream: true,
        maxCharsPerRequest: maxCharsForModel(model.id),
        qualityNotes: model.description?.slice(0, 180),
        usdPerMillionChars,
        stylePrompt: opts.stylePrompt,
        accentHint,
      };
      const enriched = enrichCatalogVoice(base);
      // Keep stylePrompt + accentHint through enrichment
      enriched.stylePrompt = opts.stylePrompt;
      if (accentHint) enriched.accentHint = accentHint;
      return enriched;
    };

    // Gemini voices are accent-steerable via prompt — expand into real variants
    // so the picker isn't a wall of "American" labels.
    if (
      modelSupportsAccentVariants(model.id) &&
      (baseLocale.startsWith("en") || baseLocale === "en-US")
    ) {
      return GEMINI_ACCENT_LOCALES.map(({ accent, locale }) =>
        makeCard({
          locale,
          idSuffix: locale,
          stylePrompt: narrationStylePrompt(accent),
          accentTag: accent,
        })
      );
    }

    // Locale-native cards (Microsoft en-US-Harper, Minimax Aussie, etc.)
    const nativeAccent = baseLocale.startsWith("en-GB")
      ? "british"
      : baseLocale.startsWith("en-AU")
        ? "australian"
        : baseLocale.startsWith("en-IE")
          ? "irish"
          : baseLocale.startsWith("en")
            ? "american"
            : undefined;

    return [
      makeCard({
        locale: baseLocale,
        stylePrompt: nativeAccent
          ? narrationStylePrompt(nativeAccent)
          : narrationStylePrompt(),
        accentTag: nativeAccent,
      }),
    ];
  });
}

export async function fetchOpenRouterCatalogVoices(): Promise<CatalogVoice[]> {
  const models = await listOpenRouterSpeechModels();
  const expanded = models.flatMap(expandModel);
  return expanded.sort((a, b) => {
    const pa = a.usdPerMillionChars ?? 999;
    const pb = b.usdPerMillionChars ?? 999;
    if (pa !== pb) return pa - pb;
    return a.displayName.localeCompare(b.displayName);
  });
}

export function findOpenRouterVoice(
  voices: CatalogVoice[],
  id: string
): CatalogVoice | undefined {
  return voices.find((v) => v.id === id);
}
