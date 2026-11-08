/**
 * Listen-time playbackRate presets for the player.
 *
 * These change how fast the browser plays already-rendered audio. They are
 * not Fish `prosody.speed` and do not re-synthesize the book.
 * One quiet cycle control in the player, plus a small chevron that opens
 * the same preset list — not a pill row.
 *
 * Nothing writes a speed preference. A reload starts at 1×, so the old
 * implicit 1.15× start cannot come back from storage. A rate picked during
 * the visit stays on the element until reload, including 1.15× when the
 * listener chooses that step.
 */

const SPEED_MIN_CENTS = 80;
const SPEED_MAX_CENTS = 150;
const SPEED_STEP_CENTS = 5;

function speedsFromCents(): readonly number[] {
  const speeds: number[] = [];
  for (let cents = SPEED_MIN_CENTS; cents <= SPEED_MAX_CENTS; cents += SPEED_STEP_CENTS) {
    speeds.push(cents / 100);
  }
  return speeds;
}

/** 0.8× through 1.5×, every 0.05. Built from integer cents so 1.35 is exact. */
export const PLAYBACK_SPEED_PRESETS = speedsFromCents();

/** Fresh listen, before the listener picks another rate. */
export const DEFAULT_PLAYBACK_SPEED = 1;

export type PlaybackSpeed = (typeof PLAYBACK_SPEED_PRESETS)[number];

function centsOf(speed: number): number {
  return Math.round(speed * 100);
}

export function playbackSpeedIndex(speed: number): number {
  return PLAYBACK_SPEED_PRESETS.findIndex((rate) => centsOf(rate) === centsOf(speed));
}

export function nextPlaybackSpeed(current: number): PlaybackSpeed {
  const idx = playbackSpeedIndex(current);
  const from = idx === -1 ? playbackSpeedIndex(DEFAULT_PLAYBACK_SPEED) : idx;
  return PLAYBACK_SPEED_PRESETS[(from + 1) % PLAYBACK_SPEED_PRESETS.length]!;
}

export function previousPlaybackSpeed(current: number): PlaybackSpeed {
  const idx = playbackSpeedIndex(current);
  const from = idx === -1 ? playbackSpeedIndex(DEFAULT_PLAYBACK_SPEED) : idx;
  return PLAYBACK_SPEED_PRESETS[
    (from - 1 + PLAYBACK_SPEED_PRESETS.length) % PLAYBACK_SPEED_PRESETS.length
  ]!;
}

/** Compact cycle-control label (`1×`, `0.95×`, `1.35×`), never a float tail. */
export function formatPlaybackSpeed(speed: number): string {
  const cents = centsOf(speed);
  const whole = Math.trunc(cents / 100);
  const frac = Math.abs(cents % 100);
  if (frac === 0) return `${whole}×`;
  if (frac % 10 === 0) return `${whole}.${frac / 10}×`;
  return `${whole}.${String(frac).padStart(2, "0")}×`;
}

export function playbackSpeedsMatch(a: number, b: number): boolean {
  return centsOf(a) === centsOf(b);
}

/**
 * Listen-time rate on the element. Pitch stays put so the narrator does not
 * change. Generation speed is a different setting and is not written here.
 */
export function assignPlaybackRate(
  audio: { playbackRate: number; defaultPlaybackRate: number; preservesPitch?: boolean },
  speed: number
): void {
  audio.defaultPlaybackRate = speed;
  audio.playbackRate = speed;
  audio.preservesPitch = true;
}
