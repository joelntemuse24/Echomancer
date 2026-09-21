/**
 * Listen-time playbackRate presets for the player.
 *
 * These change how fast the browser plays already-rendered audio. They are
 * not Fish `prosody.speed` and do not re-synthesize the book.
 * One quiet cycle control in the player, not a pill row — the set is fine
 * enough to land on 1.15 / 1.25 without a long label.
 */
export const PLAYBACK_SPEED_PRESETS = [
  0.8, 0.9, 1, 1.1, 1.15, 1.2, 1.25, 1.3, 1.4, 1.5,
] as const;

export const DEFAULT_PLAYBACK_SPEED = 1;

export type PlaybackSpeed = (typeof PLAYBACK_SPEED_PRESETS)[number];

export function nextPlaybackSpeed(current: number): PlaybackSpeed {
  const idx = PLAYBACK_SPEED_PRESETS.indexOf(current as PlaybackSpeed);
  const from = idx === -1 ? PLAYBACK_SPEED_PRESETS.indexOf(DEFAULT_PLAYBACK_SPEED) : idx;
  return PLAYBACK_SPEED_PRESETS[(from + 1) % PLAYBACK_SPEED_PRESETS.length]!;
}

/** Compact cycle-control label (`1.15×`, not `1.150×` or `Speed 1.15`). */
export function formatPlaybackSpeed(speed: number): string {
  const rounded = Math.round(speed * 100) / 100;
  return `${rounded}×`;
}
