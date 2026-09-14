/**
 * Listen-time playbackRate presets for the player.
 *
 * These change how fast the browser plays already-rendered audio. They are
 * not Fish `prosody.speed` and do not re-synthesize the book.
 * Keep the set small — one quiet cycle control in the player, not a pill row.
 */
export const PLAYBACK_SPEED_PRESETS = [0.8, 1, 1.5] as const;

export const DEFAULT_PLAYBACK_SPEED = 1;

export type PlaybackSpeed = (typeof PLAYBACK_SPEED_PRESETS)[number];

export function nextPlaybackSpeed(current: number): PlaybackSpeed {
  const idx = PLAYBACK_SPEED_PRESETS.indexOf(current as PlaybackSpeed);
  const from = idx === -1 ? PLAYBACK_SPEED_PRESETS.indexOf(DEFAULT_PLAYBACK_SPEED) : idx;
  return PLAYBACK_SPEED_PRESETS[(from + 1) % PLAYBACK_SPEED_PRESETS.length]!;
}
