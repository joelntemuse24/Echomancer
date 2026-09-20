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

/** Hosted Fish S2 target. Tagged script must stay under Fish’s ~10k limit. */
export const FISH_TARGET_CHARS = 8000;
/** Hard ceiling so `[break]` / emotion tags still fit under ~10k. */
export const FISH_HARD_MAX_CHARS = 9200;
/**
 * Take-home section 0 only — keep time-to-first-audio small.
 * Live Listen uses {@link STREAM_WINDOW_CHARS}, not this.
 */
export const FISH_FIRST_SECTION_CHARS = 2000;

const PROVIDER_LIMITS: Record<string, number> = {
  grok: 8000,
  gemini: 2800,
  fish: FISH_TARGET_CHARS,
};

const DEFAULT_MAX_CHARS = 2000;

export function hardMaxCharsForModel(opts: {
  provider?: string | null;
  model?: string | null;
  catalogMax?: number | null;
  target?: number;
}): number {
  const target = opts.target ?? maxCharsForModel(opts);
  const provider = opts.provider?.toLowerCase() || "";
  const model = opts.model?.toLowerCase() || "";
  if (provider === "fish" || model.includes("s2.1-pro") || model.includes("fish-audio")) {
    return FISH_HARD_MAX_CHARS;
  }
  return hardMaxForTargetSafe(target);
}

function hardMaxForTargetSafe(targetChars: number): number {
  const slack = Math.max(200, Math.round(targetChars * 0.25));
  return Math.max(targetChars, targetChars + slack);
}

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
