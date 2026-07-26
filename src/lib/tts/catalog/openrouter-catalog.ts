/**
 * Expand OpenRouter speech models into catalog voice cards.
 * One catalog entry per (model × voice).
 */

import type { CatalogVoice } from "@/lib/tts/types";
import {
  listOpenRouterSpeechModels,
  type OpenRouterSpeechModel,
} from "@/lib/tts/providers/openrouter";
import { enrichCatalogVoice, friendlyVoiceName } from "@/lib/tts/voice-persona";

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
  if (
    /female|woman|nova|shimmer|alloy|kore|aoede|eve|ara|harper|valeria|soleil|thalia|asteria|athena|luna|hera|selene|iris|ophelia|helena|cordelia|andromeda|amalthea|callista|delia|electra|harmonia|juno|minerva|pandora|phoebe|vesta|maia|livia|cinzia|demetra|melia|antonia|gloria|olivia|silvia|estrella|carina|celeste|diana|agathe|beatrix|cornelia|daphne|hestia|leda|rhea|aurelia|elara|kara|lara|viktoria|ama|izanami|uzume/.test(
      v
    )
  ) {
    return "female";
  }
  if (
    /male|man|echo|onyx|fable|puck|charon|fenrir|leo|rex|klaus|john|zeus|apollo|atlas|orion|orpheus|mars|saturn|pluto|neptune|hermes|janus|draco|hyperion|odysseus|arcas|aries|aquila|cesare|elio|flavio|dionisio|hector|fabian|julius|lars|roman|sander|javier|nestor|luciano|valerio|sirio|fujin|ebisu/.test(
      v
    )
  ) {
    return "male";
  }
  return "neutral";
}

function guessLocale(voice: string): string {
  const m = voice.match(/^([a-z]{2}-[A-Z]{2})/);
  if (m) return m[1]!;
  if (voice.endsWith("-en") || /-en$/i.test(voice) || voice.includes("-en-"))
    return "en-US";
  if (voice.includes("-es") || voice.endsWith("-es")) return "es-ES";
  if (voice.includes("-fr") || voice.endsWith("-fr")) return "fr-FR";
  if (voice.includes("-de") || voice.endsWith("-de")) return "de-DE";
  if (voice.includes("-it") || voice.endsWith("-it")) return "it-IT";
  if (voice.includes("-nl") || voice.endsWith("-nl")) return "nl-NL";
  if (voice.includes("-ja") || voice.endsWith("-ja")) return "ja-JP";
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

function expandModel(model: OpenRouterSpeechModel): CatalogVoice[] {
  // Skip models without advertised voices — we can't guess a valid voice ID.
  // "alloy" is OpenAI-specific and would 400 on Voxtral, Kokoro, etc.
  if (!model.supported_voices || model.supported_voices.length === 0) {
    return [];
  }

  const usdPerMillionChars = usdPerMillionFromPrompt(model.pricing?.prompt);
  const vendor = vendorFromId(model.id);
  const voices = model.supported_voices;

  return voices.map((voice) => {
    const locale = guessLocale(voice);
    const displayVoice =
      voice.includes(":")
        ? voice.split(":")[0] || voice
        : voice.replace(/^aura-2-/, "").replace(/-en$/, "");

    const base: CatalogVoice = {
      id: `or:${model.id}:${voice}`,
      provider: "openrouter" as const,
      providerVoiceId: voice,
      displayName: displayVoice,
      language: languageFromLocale(locale),
      locale,
      gender: guessGender(voice),
      style: "narration",
      tags: [vendor, "openrouter", "tts"],
      latencyClass: model.id.includes("flash") || model.id.includes("turbo") || model.id.includes("mini") || model.id.includes("kokoro")
        ? ("fast" as const)
        : model.id.includes("hd") || model.id.includes("minimax")
          ? ("quality" as const)
          : ("balanced" as const),
      model: model.id,
      recommendedForLongForm: !model.id.includes("mini"),
      supportsNativeStream: true,
      maxCharsPerRequest: model.id.includes("openai")
        ? 4000
        : model.id.includes("gemini")
          ? 3000
          : model.id.includes("zonos")
            ? 350
            : model.id.includes("kokoro")
              ? 800
              : 2000,
      qualityNotes: model.description?.slice(0, 180),
      usdPerMillionChars,
    };

    const enriched = enrichCatalogVoice(base);
    // Keep model description available but don't force it into the card title
    enriched.displayName = friendlyVoiceName(enriched);
    return enriched;
  });
}

export async function fetchOpenRouterCatalogVoices(): Promise<CatalogVoice[]> {
  const models = await listOpenRouterSpeechModels();
  const expanded = models.flatMap(expandModel);
  // Prefer models that advertise voices; keep rest too
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
