/**
 * Listen-time playbackRate presets for the player pills.
 *
 * These change how fast the browser plays already-rendered audio. They are
 * not Fish `prosody.speed` and do not re-synthesize the book.
 */
export const PLAYBACK_SPEED_PRESETS = [0.8, 0.9, 1, 1.25, 1.5, 2] as const;

export const DEFAULT_PLAYBACK_SPEED = 1;

export type PlaybackSpeed = (typeof PLAYBACK_SPEED_PRESETS)[number];
