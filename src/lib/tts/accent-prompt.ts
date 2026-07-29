/**
 * Accent-aware narration prompts for steerable TTS (Gemini).
 * Keep these soft — aggressive "IMPORTANT/ONLY" prompts have caused
 * OpenRouter Gemini to return empty PCM (44-byte silent WAV).
 */

import type { VoiceAccent } from "@/lib/tts/voice-persona";

const BASE_NARRATION =
  "Narrate this audiobook passage clearly with natural pacing and emotion appropriate to the text.";

const ACCENT_STEER: Record<VoiceAccent, string> = {
  american: "Speak in a natural General American English accent.",
  british:
    "Speak in a natural British English (Received Pronunciation) accent.",
  australian: "Speak in a natural Australian English accent.",
  irish: "Speak in a natural Irish English accent.",
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

/**
 * Gemini TTS works best when accent direction is part of the spoken input
 * (Google's documented pattern), not only a separate `prompt` field.
 * Keep this light for long passages so the model doesn't read the direction aloud.
 */
export function geminiDirectedInput(
  text: string,
  accent?: VoiceAccent | string | null
): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;

  const short = trimmed.length < 280;
  const direction =
    accent === "british"
      ? "British English"
      : accent === "australian"
        ? "Australian English"
        : accent === "irish"
          ? "Irish English"
          : accent === "american"
            ? "American English"
            : null;

  if (!direction) return trimmed;

  // Short clips (previews): Google's quoted pattern
  if (short) {
    return `Say in a clear ${direction} accent:\n"${trimmed}"`;
  }

  // Long audiobook sections: light preamble, no wrapping quotes
  return `Read the following passage aloud in a clear ${direction} accent.\n\n${trimmed}`;
}
