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
  "edge", // Microsoft Edge online TTS — app default Standard
  "paradee", // Self-hosted Paradee v1.1 int8 (Echomancer Andrew)
  "fish-audio", // Fish Audio S2.1 Pro (free + paid) — clones + legacy narrator
  "google", // Gemini TTS
  "qwen",
  "minimax",
  "microsoft",
  "x-ai", // Grok Voice on OpenRouter
  "xai", // static / direct Grok fallback
] as const;

export type AllowedSpeechVendor = (typeof ALLOWED_SPEECH_VENDORS)[number];

/**
 * Kokoro is the one deliberate exception to this block list.
 *
 * It was rejected wholesale as "poorly suited for audiobooks", which was true of
 * the generic OpenRouter catalogue dump (54 voices, most of them 15-second
 * snippets). The listed British male narrator is **one** curated Kokoro voice,
 * `bm_george`, at 800 characters per request, and it is served by
 * `hexgrad/kokoro-82m` — open weights, Apache-2.0, 82M parameters. That is a
 * product decision about one voice, not a licence to surface the whole family.
 * `isAllowedSpeechModel` therefore admits the Kokoro model and
 * `isAllowedCatalogVoice` still only lists the catalog ids in
 * `SLIM_STOCK_VOICE_IDS`.
 */
const KOKORO_MODEL_ID = "hexgrad/kokoro-82m";

/** Explicit rejects — even if a vendor somehow matches. */
const BLOCKED_MODEL_SUBSTRINGS = [
  "zonos",
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
  if (lower === KOKORO_MODEL_ID) return true;
  if (BLOCKED_MODEL_SUBSTRINGS.some((b) => lower.includes(b))) return false;
  if (lower.includes("neural2")) return false;
  const vendor = vendorFromModelId(lower);
  return (ALLOWED_SPEECH_VENDORS as readonly string[]).includes(vendor);
}

export function isAllowedCatalogVoice(voice: {
  model?: string | null;
  provider?: string | null;
}): boolean {
  if (
    voice.provider === "research" ||
    voice.provider === "fish" ||
    voice.provider === "edge" ||
    voice.provider === "paradee"
  ) {
    return true;
  }
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
