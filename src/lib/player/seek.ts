/** Listen-time skip for the player. Does not re-synthesize. */
export const SKIP_SECONDS = 10;

export function clampSeekSeconds(
  current: number,
  delta: number,
  duration: number
): number {
  const max = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const from = Number.isFinite(current) ? Math.max(0, current) : 0;
  return Math.min(max, Math.max(0, from + delta));
}
