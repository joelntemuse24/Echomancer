"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  DEFAULT_PLAYBACK_SPEED,
  normalizePlaybackSpeed,
  type PlaybackSpeed,
} from "@/lib/player/playback-speed";
import { readSpeedPref } from "@/lib/player/playback-speed-pref";
import {
  SPEED_PREF_KEY,
  browserPrefStore,
  numberPrefServerSnapshot,
  setNumberPref,
  subscribePrefs,
} from "@/lib/player/player-prefs";

/**
 * The listen-time speed, remembered between visits and shared across books.
 *
 * Read through the shared external store, so the server render always shows
 * 1× and hydration cannot disagree with storage: the stored rate appears on
 * the first client render after mount. A stored value that is not one of the
 * 0.8–1.5 presets is snapped to the nearest one.
 */
export function usePlaybackSpeed(): {
  speed: PlaybackSpeed;
  setSpeed: (next: number) => void;
} {
  const speed = useSyncExternalStore(
    subscribePrefs,
    () => readSpeedPref(browserPrefStore()),
    () => normalizePlaybackSpeed(numberPrefServerSnapshot(DEFAULT_PLAYBACK_SPEED))
  );
  const setSpeed = useCallback((next: number) => {
    // The snapshot reads through this same key, so the control and the
    // element update together even when storage refuses the write.
    setNumberPref(SPEED_PREF_KEY, normalizePlaybackSpeed(next));
  }, []);
  return { speed, setSpeed };
}
