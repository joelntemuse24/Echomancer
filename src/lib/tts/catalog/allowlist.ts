/**
 * Curated TTS vendors we want users to see.
 * Everything else on OpenRouter (Zonos, Kokoro, Deepgram, Orpheus, Sesame,
 * Voxtral, …) is excluded — slow, opaque, or poorly suited for audiobooks.
 *
 * Replicate may still be worth a later migration for prediction-level status;
 * this allowlist is the immediate product fix while we stay on OpenRouter.
 */

/** OpenRouter model-id vendor prefixes (and static provider aliases). */
export const ALLOWED_SPEECH_VENDORS = [
  "fish-audio", // Fish Audio S2.1 Pro (free + paid) — app default
  "google", // Gemini TTS
  "qwen",
  "minimax",
  "microsoft",
  "x-ai", // Grok Voice on OpenRouter
  "xai", // static / direct Grok fallback
] as const;

export type AllowedSpeechVendor = (typeof ALLOWED_SPEECH_VENDORS)[number];

/** Explicit rejects — even if a vendor somehow matches. */
const BLOCKED_MODEL_SUBSTRINGS = [
  "zonos",
  "kokoro",
  "deepgram",
  "orpheus",
  "sesame",
  "voxtral",
  "aura-",
] as const;

export function vendorFromModelId(modelId: string): string {
  const id = modelId.trim().toLowerCase();
  if (!id) return "";
  // Catalog ids like or:google/gemini-…:Kore
  const stripped = id.startsWith("or:") ? id.slice(3) : id;
  return stripped.split("/")[0] || "";
}

export function isAllowedSpeechModel(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  const lower = modelId.toLowerCase();
  // Internal research preview model slug (gated separately at the route layer)
  if (lower === "research/minimax-free") return true;
  // Direct Fish native model ids (no vendor/ prefix)
  if (
    lower === "s2.1-pro-free" ||
    lower === "s2.1-pro" ||
    lower === "s2-pro" ||
    lower === "s1"
  ) {
    return true;
  }
  if (BLOCKED_MODEL_SUBSTRINGS.some((b) => lower.includes(b))) return false;
  const vendor = vendorFromModelId(lower);
  return (ALLOWED_SPEECH_VENDORS as readonly string[]).includes(vendor);
}

export function isAllowedCatalogVoice(voice: {
  model?: string | null;
  provider?: string | null;
}): boolean {
  if (voice.provider === "research" || voice.provider === "fish") return true;
  if (voice.model && isAllowedSpeechModel(voice.model)) return true;
  // Static direct adapters: provider gemini/grok/google with matching model
  const p = (voice.provider || "").toLowerCase();
  if (p === "gemini" || p === "google") {
    return isAllowedSpeechModel(voice.model || "google/gemini");
  }
  if (p === "grok") {
    return isAllowedSpeechModel(voice.model || "x-ai/grok");
  }
  return false;
}

/**
 * Fish Audio via OpenRouter lists no supported_voices; the OpenAI-compatible
 * path takes a voice / reference id. Public system voice from Fish docs.
 */
export const FISH_SEEDED_VOICES: Array<{
  id: string;
  displayName: string;
  gender: "female" | "male" | "neutral";
  locale: string;
  style: string;
}> = [
  {
    id: "00a1b221-6137-4b73-ad62-b0cbce134167",
    displayName: "Narrator",
    gender: "neutral",
    locale: "en-US",
    style: "narration",
  },
];

/** OpenRouter model slug for the free S2.1 Pro tier (app default). */
export const FISH_S21_PRO_FREE_MODEL = "fish-audio/s2.1-pro-free:free";

/**
 * MiniMax on OpenRouter advertises empty supported_voices but accepts
 * system voice IDs. Seed a curated English set so HD cards appear.
 */
export const MINIMAX_SEEDED_VOICES: Array<{
  id: string;
  displayName: string;
  gender: "female" | "male" | "neutral";
  locale: string;
  style: string;
}> = [
  {
    id: "English_CaptivatingStoryteller",
    displayName: "Storyteller",
    gender: "male",
    locale: "en-US",
    style: "narrative",
  },
  {
    id: "English_Trustworthy_Man",
    displayName: "Trustworthy",
    gender: "male",
    locale: "en-US",
    style: "calm",
  },
  {
    id: "English_CalmWoman",
    displayName: "Calm Woman",
    gender: "female",
    locale: "en-US",
    style: "calm",
  },
  {
    id: "English_ConfidentWoman",
    displayName: "Confident",
    gender: "female",
    locale: "en-US",
    style: "confident",
  },
  {
    id: "English_Deep-VoicedGentleman",
    displayName: "Deep Gentleman",
    gender: "male",
    locale: "en-US",
    style: "deep",
  },
  {
    id: "English_Aussie_Bloke",
    displayName: "Aussie Bloke",
    gender: "male",
    locale: "en-AU",
    style: "casual",
  },
  {
    id: "English_Graceful_Lady",
    displayName: "Graceful",
    gender: "female",
    locale: "en-US",
    style: "elegant",
  },
  {
    id: "English_Magnetic_voiced_man",
    displayName: "Magnetic",
    gender: "male",
    locale: "en-US",
    style: "warm",
  },
  {
    id: "English_SereneWoman",
    displayName: "Serene",
    gender: "female",
    locale: "en-US",
    style: "serene",
  },
  {
    id: "English_Upbeat_Woman",
    displayName: "Upbeat",
    gender: "female",
    locale: "en-US",
    style: "upbeat",
  },
  {
    id: "English_SteadyMentor",
    displayName: "Mentor",
    gender: "male",
    locale: "en-US",
    style: "steady",
  },
  {
    id: "English_Sweet_Lady",
    displayName: "Sweet Lady",
    gender: "female",
    locale: "en-US",
    style: "warm",
  },
];
