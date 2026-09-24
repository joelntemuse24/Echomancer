/** Listen-time skip for the player. Does not re-synthesize. */
export const SKIP_SECONDS = 10;

/**
 * Whole-book files longer than this get a second slider. A finger on the
 * full-length bar covers minutes; this window is two minutes, so the same
 * gesture lands within a few seconds.
 */
export const FINE_SEEK_MIN_DURATION_SECONDS = 20 * 60;
export const FINE_SEEK_WINDOW_SECONDS = 120;

export function fineSeekBounds(
  current: number,
  duration: number,
  windowSeconds = FINE_SEEK_WINDOW_SECONDS
): { start: number; end: number } | null {
  if (!Number.isFinite(duration) || duration < FINE_SEEK_MIN_DURATION_SECONDS) {
    return null;
  }
  const window = Math.min(
    duration,
    Math.max(10, windowSeconds)
  );
  const at = Number.isFinite(current) ? Math.min(duration, Math.max(0, current)) : 0;
  const end = Math.min(duration, Math.max(0, at - window / 2) + window);
  const start = Math.max(0, end - window);
  return { start, end };
}

export function clampSeekSeconds(
  current: number,
  delta: number,
  duration: number
): number {
  const max = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const from = Number.isFinite(current) ? Math.max(0, current) : 0;
  return Math.min(max, Math.max(0, from + delta));
}
