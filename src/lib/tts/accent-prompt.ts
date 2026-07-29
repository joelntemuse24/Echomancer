/**
 * Accent-aware narration prompts for steerable TTS (Gemini).
 * OpenRouter Gemini speech accepts a `prompt` that controls delivery/accent.
 */

import type { VoiceAccent } from "@/lib/tts/voice-persona";

const BASE_NARRATION =
  "Narrate this audiobook passage clearly with natural pacing and emotion appropriate to the text.";

const ACCENT_STEER: Record<VoiceAccent, string> = {
  american:
    "IMPORTANT: Speak ONLY in a clear General American English accent (USA). Do not use British, Australian, or Irish pronunciation.",
  british:
    "IMPORTANT: Speak ONLY in a clear British English Received Pronunciation accent (UK). Do not use an American accent. Use British pronunciation and intonation throughout.",
  australian:
    "IMPORTANT: Speak ONLY in a clear Australian English accent. Do not use an American or British RP accent. Use Australian pronunciation and intonation throughout.",
  irish:
    "IMPORTANT: Speak ONLY in a clear Irish English accent. Do not use an American accent. Use Irish pronunciation and intonation throughout.",
  other: "",
};

export const GEMINI_ACCENT_LOCALES: Array<{
  accent: Exclude<VoiceAccent, "other">;
  locale: string;
}> = [
  { accent: "american", locale: "en-US" },
  { accent: "british", locale: "en-GB" },
  { accent: "australian", locale: "en-AU" },
  { accent: "irish", locale: "en-IE" },
];

export function narrationStylePrompt(accent?: VoiceAccent | null): string {
  const steer = accent ? ACCENT_STEER[accent] : "";
  return steer ? `${steer} ${BASE_NARRATION}` : BASE_NARRATION;
}

/** Whether this model can be steered into accent variants via stylePrompt. */
export function modelSupportsAccentVariants(modelId: string): boolean {
  return modelId.toLowerCase().includes("gemini");
}
