/**
 * Read and write the one remembered listen-time speed.
 *
 * Kept next to the presets so a caller never has to know that the value is
 * stored as a number string, and so a stale or hand-edited value can only
 * come back as one of the real 0.8×–1.5× presets.
 */

import {
  DEFAULT_PLAYBACK_SPEED,
  normalizePlaybackSpeed,
  type PlaybackSpeed,
} from "@/lib/player/playback-speed";
import { SPEED_PREF_KEY, readNumberPref, type PrefStore, writeNumberPref } from "@/lib/player/player-prefs";

/** The remembered rate, or 1× when nothing usable is stored. */
export function readSpeedPref(store: PrefStore): PlaybackSpeed {
  return normalizePlaybackSpeed(readNumberPref(store, SPEED_PREF_KEY, DEFAULT_PLAYBACK_SPEED));
}

export function writeSpeedPref(store: PrefStore, speed: number): void {
  writeNumberPref(store, SPEED_PREF_KEY, normalizePlaybackSpeed(speed));
}
