/**
 * Per-request character ceilings.
 *
 * Every speech model rejects (or silently truncates) input past its own limit,
 * and the limits differ by an order of magnitude. The catalog value is
 * authoritative when present; these fallbacks keep unknown models from being
 * sent a whole chapter.
 *
 * Google Cloud TTS is special: the 5000 cap is UTF-8 **bytes of the final
 * SSML**, not speakable char count. Whole-book packing uses
 * `googleSynthesisSsmlUtf8Bytes` with {@link GOOGLE_SSML_HARD_MAX_BYTES}.
 */

import { GOOGLE_SSML_HARD_MAX_BYTES } from "@/lib/tts/ssml-pauses";

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
 * Whole-book Fish packing no longer uses this when even fan-out packing is on.
 */
export const FISH_FIRST_SECTION_CHARS = 2000;

/**
 * Floor for even Whole-book packing so a tiny book is not sliced into
 * fan-out stubs shorter than a paragraph.
 */
export const FISH_EVEN_PACK_MIN_CHARS = 1500;

/**
 * Whole-book Fish / clone packing: pick a per-section target so `fanout`
 * workers get similar-sized slices.
 *
 * 1. Fewest waves that still fit under {@link FISH_HARD_MAX_CHARS}.
 * 2. `ceil(chars / (waves × fanout))`.
 * 3. Floor at {@link FISH_EVEN_PACK_MIN_CHARS}; cap at {@link FISH_TARGET_CHARS}
 *    so the packer still has overflow room up to the hard max.
 *
 * Live Listen does not call this — it keeps {@link STREAM_WINDOW_CHARS}.
 */
export function evenTakehomeTargetChars(
  totalChars: number,
  fanout: number
): number {
  const workers = Math.max(1, Math.floor(fanout) || 1);
  const chars = Math.max(0, Math.floor(Number(totalChars)) || 0);
  const waves = Math.max(
    1,
    Math.ceil(chars / (workers * FISH_HARD_MAX_CHARS))
  );
  const even = Math.ceil(chars / (waves * workers));
  return Math.min(
    FISH_TARGET_CHARS,
    Math.max(FISH_EVEN_PACK_MIN_CHARS, even)
  );
}

const PROVIDER_LIMITS: Record<string, number> = {
  grok: 8000,
  gemini: 2800,
  fish: FISH_TARGET_CHARS,
  google: 4500,
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
  if (provider === "google" || model.startsWith("google/en-")) {
    return GOOGLE_SSML_HARD_MAX_BYTES;
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
