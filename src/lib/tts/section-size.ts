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
 * First take-home section for every provider. About 45–60 seconds, so the
 * first audio arrives quickly without a 27-character title on its own.
 */
export const FIRST_SECTION_CHARS = 800;

/**
 * A heading does not open a new section until the open one holds about this
 * much (about 90 seconds). Shorter chapters stay as markers inside it.
 * A voice packed at a smaller target (Kokoro CPU, ~700 chars) passes its own
 * target as the packer's `minSectionChars`, so a heading still breaks a
 * section it can never fill.
 */
export const MIN_SECTION_CHARS = 1500;

/**
 * Section target for the Kokoro CPU voices (Drew, Walter, George).
 *
 * Each section is one HTTP call to one container on the `echomancer-sowell`
 * fleet, so section length sets both the tail and the per-call latency. At
 * ~2x realtime a 2,000-character section is ~90 s of audio and 22-47 s of
 * wall; a 700-character section is ~30 s of audio and 8-15 s of wall, so the
 * last wave of a book drains much faster and a lane that frees late still
 * has small work to claim.
 *
 * Kokoro's own ceiling is 2,000 characters (the engine splits at 510
 * phonemes internally), so this target is clamped to
 * {@link KOKORO_CPU_SECTION_CHARS_MAX}.
 */
export const KOKORO_CPU_SECTION_CHARS_DEFAULT = 700;
export const KOKORO_CPU_SECTION_CHARS_MIN = 300;
export const KOKORO_CPU_SECTION_CHARS_MAX = 2000;
/** Absolute per-request ceiling in the Modal container (`MAX_CHARS`). */
export const KOKORO_CPU_REQUEST_MAX_CHARS = 2000;
/** First section: about 15-20 s of audio, so first sound is fast. */
export const KOKORO_CPU_FIRST_SECTION_CHARS = 400;
/** Second section: a step up before the steady target. */
export const KOKORO_CPU_SECOND_SECTION_CHARS = 550;

/** True for the catalog ids served by the Kokoro CPU fleet. */
export function isKokoroCpuProvider(provider?: string | null): boolean {
  const id = provider?.toLowerCase() || "";
  return id === "sowell" || id === "drew" || id === "george" || id === "heart";
}

/**
 * Configured Kokoro-CPU section target. `KOKORO_CPU_SECTION_CHARS` sets it;
 * the default is {@link KOKORO_CPU_SECTION_CHARS_DEFAULT}. Clamped to
 * 300..2000, so a mis-set env cannot ask for a one-word section or a call the
 * container would reject.
 */
export function kokoroCpuSectionChars(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.KOKORO_CPU_SECTION_CHARS?.trim();
  const parsed = raw ? Number(raw) : KOKORO_CPU_SECTION_CHARS_DEFAULT;
  const n = Number.isFinite(parsed)
    ? Math.floor(parsed)
    : KOKORO_CPU_SECTION_CHARS_DEFAULT;
  return Math.min(
    KOKORO_CPU_SECTION_CHARS_MAX,
    Math.max(KOKORO_CPU_SECTION_CHARS_MIN, n)
  );
}

/**
 * Everything the packer needs for a Kokoro-CPU book: the steady target, the
 * short opening ramp, and a hard max with the usual overflow slack but never
 * past the container's 2,000-character request cap.
 */
export function kokoroCpuSectionPlan(env: NodeJS.ProcessEnv = process.env): {
  maxChars: number;
  firstSectionMaxChars: number;
  secondSectionMaxChars: number;
  thirdSectionMaxChars: number;
  hardMaxChars: number;
} {
  const maxChars = kokoroCpuSectionChars(env);
  const first = Math.min(KOKORO_CPU_FIRST_SECTION_CHARS, maxChars);
  const second = Math.min(KOKORO_CPU_SECOND_SECTION_CHARS, maxChars);
  return {
    maxChars,
    firstSectionMaxChars: first,
    secondSectionMaxChars: second,
    thirdSectionMaxChars: maxChars,
    // The packer may run 25% past the target to reach a paragraph break, but
    // a section can never exceed what one container call accepts.
    hardMaxChars: Math.min(
      KOKORO_CPU_REQUEST_MAX_CHARS,
      hardMaxForTargetLocal(maxChars)
    ),
  };
}

/** Same slack as `hardMaxForTarget` in split-text, without the import cycle. */
function hardMaxForTargetLocal(targetChars: number): number {
  const slack = Math.max(200, Math.round(targetChars * 0.25));
  return targetChars + slack;
}

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
  { engine: "sowell", matches: ["sowell/"], maxChars: 2000 },
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
  if (
    provider === "sowell" ||
    provider === "george" ||
    provider === "heart" ||
    provider === "drew"
  ) {
    return Math.min(target, 2000);
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
  if (
    opts.provider === "sowell" ||
    opts.provider === "george" ||
    opts.provider === "heart" ||
    opts.provider === "drew"
  ) {
    return 2000;
  }
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
