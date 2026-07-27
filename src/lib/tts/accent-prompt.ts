/**
 * Accent-aware narration prompts for steerable TTS (Gemini).
 * OpenRouter Gemini speech accepts a `prompt` that controls delivery/accent.
 */

import type { VoiceAccent } from "@/lib/tts/voice-persona";

const BASE_NARRATION =
  "Narrate this audiobook passage clearly with natural pacing and emotion appropriate to the text.";

const ACCENT_STEER: Record<VoiceAccent, string> = {
  american:
    "Speak in a natural General American English accent.",
  british:
    "Speak in a natural British English (Received Pronunciation) accent.",
  australian:
    "Speak in a natural Australian English accent.",
  irish:
    "Speak in a natural Irish English accent.",
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
