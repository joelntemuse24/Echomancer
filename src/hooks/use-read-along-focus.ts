"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  FULLSCREEN_PREF_KEY,
  boolPrefServerSnapshot,
  boolPrefSnapshot,
  setBoolPref,
  subscribePrefs,
} from "@/lib/player/player-prefs";

/**
 * Focus (full-screen) read-along, remembered between visits.
 *
 * Read through an external store rather than an effect: the server render
 * has no storage, and a value written here also survives a refused
 * localStorage write. The overlay therefore opens after hydration, which is
 * the point — it must not exist in the server markup.
 */
export function useReadAlongFocus(): {
  focus: boolean;
  setFocus: (next: boolean) => void;
} {
  const focus = useSyncExternalStore(
    subscribePrefs,
    () => boolPrefSnapshot(FULLSCREEN_PREF_KEY, false),
    () => boolPrefServerSnapshot(false)
  );
  const setFocus = useCallback((next: boolean) => setBoolPref(FULLSCREEN_PREF_KEY, next), []);
  return { focus, setFocus };
}
