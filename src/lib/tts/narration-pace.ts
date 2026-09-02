/**
 * Fish `prosody.speed` for long-form narration (not ffmpeg atempo).
 *
 * Audiobook feel still comes from pause tags (`narration-script.ts`). This
 * module sets generation speed so **speech** WPM lands near 150–155. Pause
 * ratio is not inter-word rate — a 0.13 silence share can still rush.
 */

import { isFishCloneCatalogId } from "@/lib/tts/fish-clone";
import { splitSentences } from "@/lib/tts/speakable-text";

/** Target long-form narration rate (words per minute of speech). */
export const TARGET_LONGFORM_WPM = 152;

/** Out-of-the-box Fish speed for stock Narrator + conversational prose. */
export const DEFAULT_NARRATION_SPEED = 1.0;

/** Fish `prosody.speed` clamp — 0.75 reaches ~152 speech WPM from ~194. */
export const FISH_SPEED_MIN = 0.75;
export const FISH_SPEED_MAX = 1.0;

/**
 * Typical Fish s2.1-pro-free speech rate at speed 1 (Wolfe QA ≈ 194).
 * Used only as context for the first-section start band.
 */
export const TYPICAL_FISH_SPEECH_WPM = 190;

/**
 * First-section start for clones and dense academic (0.82–0.88).
 * 152/190 ≈ 0.80; stay slightly above the floor so we can still calibrate down.
 */
export const INITIAL_SLOW_SPEED = 0.85;

/** Same threshold narration-script uses before inserting `[break]`. */
const ACADEMIC_AVG_CHARS_PER_SENTENCE = 100;
const ACADEMIC_LONG_SENTENCE_CHARS = 140;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function roundSpeed(n: number): number {
  return Math.round(n * 100) / 100;
}

export function clampFishSpeed(speed: number): number {
  return clamp(roundSpeed(speed), FISH_SPEED_MIN, FISH_SPEED_MAX);
}

/** Speech-time WPM: wall − silence when known, else wall duration. */
export function speechWpm(input: {
  wordCount: number;
  durationSec: number;
  silenceSec?: number;
}): number {
  if (input.wordCount <= 0 || input.durationSec <= 0) return 0;
  const speechSec =
    input.silenceSec != null && Number.isFinite(input.silenceSec)
      ? Math.max(0.01, input.durationSec - Math.max(0, input.silenceSec))
      : input.durationSec;
  if (speechSec <= 0) return 0;
  return (input.wordCount / speechSec) * 60;
}

export function calibrateNarrationSpeed(input: {
  currentSpeed: number;
  wordCount: number;
  durationSec: number;
  silenceSec?: number;
}): number {
  const current = Number.isFinite(input.currentSpeed)
    ? input.currentSpeed
    : DEFAULT_NARRATION_SPEED;
  if (input.wordCount <= 0 || input.durationSec <= 0) {
    return clampFishSpeed(current);
  }

  const measuredWpm = speechWpm(input);
  if (measuredWpm <= 0) {
    return clampFishSpeed(current);
  }

  // Leave a take that already sits on the long-form target.
  if (
    measuredWpm >= TARGET_LONGFORM_WPM - 8 &&
    measuredWpm <= TARGET_LONGFORM_WPM + 8
  ) {
    return clampFishSpeed(current);
  }

  const next = current * (TARGET_LONGFORM_WPM / measuredWpm);
  return clampFishSpeed(next);
}

export function isDenseAcademicText(text: string): boolean {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length < 80) return false;
  const sentences = splitSentences(cleaned);
  if (sentences.length === 0) return false;
  const avg = cleaned.length / sentences.length;
  if (avg >= ACADEMIC_AVG_CHARS_PER_SENTENCE) return true;
  const long = sentences.filter(
    (s) => s.trim().length >= ACADEMIC_LONG_SENTENCE_CHARS
  ).length;
  return long >= 1 && long / sentences.length >= 0.25;
}

/**
 * Speed for section 0 / Live Listen before any take is measured.
 * Clones of conversational refs and dense academic start ~0.85;
 * stock Narrator on conversational prose stays 1.0.
 */
export function initialNarrationSpeed(input: {
  catalogVoiceId?: string | null;
  text?: string | null;
}): number {
  const clone = isFishCloneCatalogId(input.catalogVoiceId);
  const academic = input.text ? isDenseAcademicText(input.text) : false;
  if (clone || academic) return INITIAL_SLOW_SPEED;
  return DEFAULT_NARRATION_SPEED;
}

/** Omit default 1.0 so Fish does not get an empty `prosody` object. */
export function fishSpeedForRequest(speed?: number): number | undefined {
  if (typeof speed !== "number" || !Number.isFinite(speed)) return undefined;
  const clamped = clampFishSpeed(speed);
  return clamped === DEFAULT_NARRATION_SPEED ? undefined : clamped;
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
