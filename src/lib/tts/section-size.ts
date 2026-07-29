/**
 * Per-request character ceilings.
 *
 * Every speech model rejects (or silently truncates) input past its own limit,
 * and the limits differ by an order of magnitude. The catalog value is
 * authoritative when present; these fallbacks keep unknown models from being
 * sent a whole chapter.
 */

const MODEL_LIMITS: { match: string; maxChars: number }[] = [
  { match: "openai", maxChars: 4000 },
  { match: "gemini", maxChars: 3000 },
  { match: "zonos", maxChars: 350 },
  { match: "kokoro", maxChars: 800 },
];

const PROVIDER_LIMITS: Record<string, number> = {
  grok: 8000,
  gemini: 2800,
};

const DEFAULT_MAX_CHARS = 2000;

export function maxCharsForModel(opts: {
  provider?: string | null;
  model?: string | null;
  catalogMax?: number | null;
}): number {
  if (opts.catalogMax && opts.catalogMax > 0) return opts.catalogMax;

  const model = opts.model?.toLowerCase() || "";
  for (const limit of MODEL_LIMITS) {
    if (model.includes(limit.match)) return limit.maxChars;
  }

  const provider = opts.provider?.toLowerCase() || "";
  return PROVIDER_LIMITS[provider] ?? DEFAULT_MAX_CHARS;
}

/**
 * Live listen uses smaller windows than take-home: the first window gates
 * time-to-first-sound, so a 2000-character request would leave the user staring
 * at a spinner.
 */
export const STREAM_WINDOW_CHARS = 480;

export function streamWindowChars(maxChars: number): number {
  return Math.min(maxChars, STREAM_WINDOW_CHARS);
}
