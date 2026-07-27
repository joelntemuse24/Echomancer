/** Resolve the style/accent prompt for a stock TTS call. */
export function resolveStylePrompt(opts: {
  catalogStylePrompt?: string | null;
  ttsOptionsStylePrompt?: string | null;
  locale?: string | null;
}): string {
  if (opts.ttsOptionsStylePrompt) return opts.ttsOptionsStylePrompt;
  if (opts.catalogStylePrompt) return opts.catalogStylePrompt;

  const locale = (opts.locale || "").toLowerCase();
  if (locale.startsWith("en-gb")) {
    return "Speak in a natural British English (Received Pronunciation) accent. Narrate this audiobook passage clearly with natural pacing and emotion appropriate to the text.";
  }
  if (locale.startsWith("en-au")) {
    return "Speak in a natural Australian English accent. Narrate this audiobook passage clearly with natural pacing and emotion appropriate to the text.";
  }
  if (locale.startsWith("en-ie")) {
    return "Speak in a natural Irish English accent. Narrate this audiobook passage clearly with natural pacing and emotion appropriate to the text.";
  }
  return "Narrate this audiobook passage clearly with natural pacing and emotion appropriate to the text.";
}
