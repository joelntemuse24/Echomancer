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
import { enrichCatalogVoice, friendlyVoiceName } from "@/lib/tts/voice-persona";
import {
  isAllowedSpeechModel,
  MINIMAX_SEEDED_VOICES,
} from "@/lib/tts/catalog/allowlist";

/** pricing.prompt is USD per character on OpenRouter TTS models */
function usdPerMillionFromPrompt(prompt?: string): number | undefined {
  if (!prompt) return undefined;
  const perChar = Number(prompt);
  if (!Number.isFinite(perChar) || perChar <= 0) return undefined;
  return Math.round(perChar * 1_000_000 * 1000) / 1000;
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
  if (modelId.includes("gemini")) return 3000;
  if (modelId.includes("minimax")) return 2500;
  if (modelId.includes("qwen")) return 2000;
  if (modelId.includes("microsoft")) return 2000;
  if (modelId.includes("grok") || modelId.includes("x-ai")) return 2000;
  return 2000;
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

  const usdPerMillionChars = usdPerMillionFromPrompt(model.pricing?.prompt);
  const vendor = vendorFromId(model.id);
  const seeded = model.id.toLowerCase().includes("minimax")
    ? new Map(MINIMAX_SEEDED_VOICES.map((v) => [v.id, v]))
    : null;

  return voices.map((voice) => {
    const seed = seeded?.get(voice);
    const locale = seed?.locale || guessLocale(voice);
    const displayVoice =
      seed?.displayName ||
      (voice.includes(":")
        ? voice.split(":")[0] || voice
        : voice.replace(/^aura-2-/, "").replace(/-en$/, ""));

    const base: CatalogVoice = {
      id: `or:${model.id}:${voice}`,
      provider: "openrouter" as const,
      providerVoiceId: voice,
      displayName: displayVoice,
      language: languageFromLocale(locale),
      locale,
      gender: seed?.gender || guessGender(voice),
      style: seed?.style || "narration",
      tags: [
        vendor,
        "openrouter",
        "tts",
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
    };

    const enriched = enrichCatalogVoice(base);
    enriched.displayName = friendlyVoiceName(enriched);
    return enriched;
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
