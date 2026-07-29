/** Resolve the style/accent prompt for a stock TTS call. */

import { narrationStylePrompt } from "@/lib/tts/accent-prompt";
import type { VoiceAccent } from "@/lib/tts/voice-persona";

function accentFromLocale(locale?: string | null): VoiceAccent | null {
  const l = (locale || "").toLowerCase();
  if (l.startsWith("en-gb")) return "british";
  if (l.startsWith("en-au")) return "australian";
  if (l.startsWith("en-ie")) return "irish";
  if (l.startsWith("en-us") || l === "en") return "american";
  return null;
}

export function resolveStylePrompt(opts: {
  catalogStylePrompt?: string | null;
  ttsOptionsStylePrompt?: string | null;
  locale?: string | null;
  accent?: string | null;
}): string {
  if (opts.ttsOptionsStylePrompt) return opts.ttsOptionsStylePrompt;
  if (opts.catalogStylePrompt) return opts.catalogStylePrompt;

  const accent =
    (opts.accent as VoiceAccent | null | undefined) ||
    accentFromLocale(opts.locale);
  return narrationStylePrompt(accent);
}
