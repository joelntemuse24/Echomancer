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

/** Hosted Fish S2 target. Tagged script must stay under Fish’s ~10k limit. */
export const FISH_TARGET_CHARS = 8000;
/** Hard ceiling so `[break]` / emotion tags still fit under ~10k. */
export const FISH_HARD_MAX_CHARS = 9200;
/**
 * Take-home section 0 only — keep time-to-first-audio small.
 * Live Listen uses {@link STREAM_WINDOW_CHARS}, not this.
 * Whole-book packing uses {@link FIRST_SECTION_CHARS} for every provider.
 * This wider cap remains for a caller that still passes it explicitly.
 */
export const FISH_FIRST_SECTION_CHARS = 2000;

/**
 * First take-home section for every provider. About 45–60 seconds, so the
 * first audio arrives quickly without a 27-character title on its own.
 */
export const FIRST_SECTION_CHARS = 800;

/**
 * A heading does not open a new section until the open one holds about this
 * much (about 90 seconds). Shorter chapters stay as markers inside it.
 */
export const MIN_SECTION_CHARS = 1500;

/**
 * Floor for even Whole-book packing so a tiny book is not sliced into
 * fan-out stubs shorter than a paragraph.
 */
export const FISH_EVEN_PACK_MIN_CHARS = 1500;

/** Edge/Google whole-book target: one wave of this many sections when the book fits. */
export const EDGE_GOOGLE_PACK_SECTIONS = 8;
/** Do not slice a short book into stubs below a paragraph. */
export const EDGE_GOOGLE_PACK_MIN_CHARS = 1500;

/**
 * Per-section target for Edge and Google. `ceil(chars / 8)`, floored at
 * {@link EDGE_GOOGLE_PACK_MIN_CHARS} and capped at the voice's existing max
 * (4,000 for Standard). The packer still breaks on a paragraph or sentence.
 */
export function edgeGoogleTakehomeTargetChars(
  totalChars: number,
  maxChars: number
): number {
  const cap = Math.max(1, Math.floor(maxChars) || 4000);
  const chars = Math.max(0, Math.floor(Number(totalChars)) || 0);
  const even = Math.ceil(chars / EDGE_GOOGLE_PACK_SECTIONS);
  const floor = Math.min(EDGE_GOOGLE_PACK_MIN_CHARS, cap);
  return Math.min(cap, Math.max(floor, even));
}

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

/** Model overrides retain catalog-independent limits; provider defaults are explicit. */
const MODEL_LIMITS = [
  { engine: "openai", matches: ["openai"], maxChars: 4000 },
  { engine: "gemini", matches: ["gemini"], maxChars: 2800, modelMaxChars: 3000 },
  { engine: "fish", matches: ["fish", "s2.1-pro"], maxChars: FISH_TARGET_CHARS },
  { engine: "edge", matches: ["edge"], maxChars: 2000 },
  { engine: "google", matches: ["google/en-"], maxChars: 4500 },
  { engine: "minimax", matches: ["minimax"], maxChars: 2000 },
  { engine: "zonos", matches: ["zonos"], maxChars: 350 },
  { engine: "elevenlabs", matches: ["elevenlabs"], maxChars: 2000 },
  { engine: "kokoro", matches: ["kokoro"], maxChars: 800 },
  { engine: "grok", matches: ["grok"], maxChars: 8000 },
  { engine: "other", matches: [], maxChars: 2000 },
];

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
  return Math.min(target, maxCharsForModel(opts));
}

/**
 * Drop a baseline catalog ceiling when the stored job provider is different,
 * so a Fish row is not capped by an Edge or Google card.
 */
export function catalogMaxForStoredProvider(opts: {
  storedProvider?: string | null;
  catalogProvider?: string | null;
  catalogMax?: number | null;
}): number | undefined {
  const max = opts.catalogMax;
  if (!max || max <= 0) return undefined;
  const stored = opts.storedProvider?.toLowerCase() || "";
  const catalog = opts.catalogProvider?.toLowerCase() || "";
  if (stored && catalog && stored !== catalog) return undefined;
  return max;
}

export function maxCharsForModel(opts: {
  provider?: string | null;
  model?: string | null;
  catalogMax?: number | null;
}): number {
  if (opts.catalogMax && opts.catalogMax > 0) return opts.catalogMax;

  const model = opts.model?.toLowerCase() || "";
  for (const limit of MODEL_LIMITS) {
    if (limit.matches.some((match) => model.includes(match))) {
      return limit.modelMaxChars ?? limit.maxChars;
    }
  }

  const provider = opts.provider?.toLowerCase() || "";
  return (MODEL_LIMITS.find((limit) => limit.engine === provider) ??
    MODEL_LIMITS.find((limit) => limit.engine === "other")!).maxChars;
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
