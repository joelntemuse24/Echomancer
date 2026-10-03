/** Listen-time skip for the player. Does not re-synthesize. */
export const SKIP_SECONDS = 10;

/**
 * A finger on the full-length bar covers minutes; this window is two
 * minutes, so the same gesture lands within a few seconds.
 */
export const FINE_SEEK_WINDOW_SECONDS = 120;

/**
 * Audio at least this long shows the fine slider as soon as the player
 * loads. Shorter audio gets it on the first scrub, then keeps it for the
 * rest of the visit.
 */
export const FINE_SEEK_ALWAYS_SECONDS = 30 * 60;

export function fineSeekBounds(
  current: number,
  duration: number,
  windowSeconds = FINE_SEEK_WINDOW_SECONDS
): { start: number; end: number } | null {
  if (!Number.isFinite(duration) || duration <= 0) {
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

/**
 * Anchor for the fine window, on a half-minute grid. Playback recentres
 * the window at most once a minute, the playhead never leaves it, and a
 * seek always lands inside. A held fine drag pins the window instead.
 */
export function fineSeekAnchor(at: number): number {
  if (!Number.isFinite(at) || at <= 0) return 0;
  return Math.floor(at / 60) * 60 + 30;
}

/**
 * The window the fine slider shows around `at`: the grid anchor's bounds,
 * or `pinned` while a fine drag holds the window still.
 */
export function fineSeekWindow(
  at: number,
  duration: number,
  pinned?: { start: number; end: number } | null
): { start: number; end: number } | null {
  if (pinned) return pinned;
  return fineSeekBounds(fineSeekAnchor(at), duration);
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

/** m:ss, h:mm:ss past an hour — the player's quiet clocks. */
export function formatPlayClock(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const clock = `${mins}:${secs.toString().padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}` : clock;
}