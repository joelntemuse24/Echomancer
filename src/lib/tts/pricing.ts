/**
 * Dynamic take-home price estimator.
 * €4.50 is a product TARGET for a typical standard novel, not a hard ceiling.
 */

import type { CatalogVoice, PriceEstimate } from "@/lib/tts/types";

/** ~150 wpm × ~6 chars/word × 60 min */
export const CHARS_PER_AUDIO_HOUR = 54_000;

/** Product target for a typical standard book (not a hard max). */
export const TARGET_PRICE_EUR = 4.5;

const DEFAULT_MARKUP = Number(process.env.TTS_PRICE_MARKUP || "2.0");
const DEFAULT_FIXED_EUR = Number(process.env.TTS_PRICE_FIXED_EUR || "0.5");
const DEFAULT_FX = Number(process.env.TTS_USD_TO_EUR || "0.92");
const DEFAULT_MIN_EUR = Number(process.env.TTS_MIN_PRICE_EUR || "1.99");

export function estimateAudioHours(charCount: number): number {
  if (charCount <= 0) return 0;
  return charCount / CHARS_PER_AUDIO_HOUR;
}

/**
 * Estimate TTS COGS in USD for a voice + character count.
 */
export function estimateTtsCogsUsd(
  charCount: number,
  voice: Pick<CatalogVoice, "usdPerMillionChars" | "usdPerAudioHour" | "model">
): number {
  const hours = estimateAudioHours(charCount);
  if (voice.usdPerAudioHour != null) {
    return hours * voice.usdPerAudioHour;
  }
  if (voice.usdPerMillionChars != null) {
    return (charCount / 1_000_000) * voice.usdPerMillionChars;
  }
  // Fallback: mid-tier character rate
  return (charCount / 1_000_000) * 15;
}

/**
 * Suggest EUR retail price from COGS + markup + fixed overhead.
 * Rounds to .49 / .99 style for cleaner checkout later.
 */
export function estimatePriceEur(opts: {
  charCount: number;
  voice: CatalogVoice;
  markup?: number;
  fixedEur?: number;
  fxUsdToEur?: number;
  minEur?: number;
}): PriceEstimate {
  const markup = opts.markup ?? DEFAULT_MARKUP;
  const fixedEur = opts.fixedEur ?? DEFAULT_FIXED_EUR;
  const fx = opts.fxUsdToEur ?? DEFAULT_FX;
  const minEur = opts.minEur ?? DEFAULT_MIN_EUR;

  const hours = estimateAudioHours(opts.charCount);
  const ttsCogsUsd = estimateTtsCogsUsd(opts.charCount, opts.voice);
  const raw =
    ttsCogsUsd * fx * markup + fixedEur;
  const suggested = Math.max(minEur, roundPriceEur(raw));

  return {
    charCount: opts.charCount,
    estimatedAudioHours: Math.round(hours * 100) / 100,
    estimatedAudioMinutes: Math.round(hours * 60),
    ttsCogsUsd: Math.round(ttsCogsUsd * 1000) / 1000,
    suggestedPriceEur: suggested,
    currency: "EUR",
    provider: opts.voice.provider,
    model: opts.voice.model,
    targetPriceEur: TARGET_PRICE_EUR,
    breakdown: {
      charsPerHour: CHARS_PER_AUDIO_HOUR,
      markup,
      fixedEur,
      fxUsdToEur: fx,
    },
  };
}

function roundPriceEur(n: number): number {
  if (n < 3) return Math.round(n * 2) / 2; // 0.5 steps
  // nearest .49 or .99
  const base = Math.floor(n);
  const frac = n - base;
  if (frac < 0.25) return base - 0.01 > 0 ? base - 0.01 : 0.99;
  if (frac < 0.75) return base + 0.49;
  return base + 0.99;
}

/** Stream budget: ~1 hour of audio in characters */
export function streamMaxChars(): number {
  const seconds = Number(process.env.STREAM_MAX_AUDIO_SECONDS || "3600");
  const cpm = Number(process.env.STREAM_CHARS_PER_MINUTE || "900");
  return Math.floor((seconds / 60) * cpm);
}
