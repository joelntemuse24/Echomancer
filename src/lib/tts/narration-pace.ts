/**
 * Light Fish `prosody.speed` clamp — last resort only.
 *
 * Audiobook feel comes from pauses (`narration-script.ts`), not slower vowels.
 * Joel's 0.85/0.9 atempo stretches still sounded fast *and* slurred. This
 * module never defaults the product to 0.85. It only nudges 0.9–1.0 when
 * measured speech is extreme *and* the take does not already have book-like
 * silence.
 */

/** Target long-form narration rate (words per minute). */
export const TARGET_LONGFORM_WPM = 152;

/** Out-of-the-box Fish speed. Never a hardcoded 0.85. */
export const DEFAULT_NARRATION_SPEED = 1.0;

/** Light clamp — never stretch below this, never rush above it. */
export const FISH_SPEED_MIN = 0.9;
export const FISH_SPEED_MAX = 1.0;

/** Only consider a speed nudge when measured WPM is this far from a book. */
export const EXTREME_FAST_WPM = 200;
export const EXTREME_SLOW_WPM = 90;

/**
 * Healthy audiobook pause share of wall time. A 150 WPM file with 260ms
 * median gaps still sounds like a newscast — if silence is already ~12%+,
 * do not slow the vowels.
 */
export const BOOK_PAUSE_RATIO = 0.12;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
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
    return clamp(current, FISH_SPEED_MIN, FISH_SPEED_MAX);
  }

  if (
    input.silenceSec != null &&
    input.silenceSec >= 0 &&
    input.silenceSec / input.durationSec >= BOOK_PAUSE_RATIO
  ) {
    return DEFAULT_NARRATION_SPEED;
  }

  const speechSec =
    input.silenceSec != null
      ? Math.max(0.01, input.durationSec - input.silenceSec)
      : input.durationSec;
  const measuredWpm = (input.wordCount / speechSec) * 60;

  if (measuredWpm <= EXTREME_FAST_WPM && measuredWpm >= EXTREME_SLOW_WPM) {
    return DEFAULT_NARRATION_SPEED;
  }

  const next = current * (TARGET_LONGFORM_WPM / measuredWpm);
  return clamp(next, FISH_SPEED_MIN, FISH_SPEED_MAX);
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
