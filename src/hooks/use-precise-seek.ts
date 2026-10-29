"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  PRECISE_SEEK_PREF_KEY,
  boolPrefServerSnapshot,
  boolPrefSnapshot,
  setBoolPref,
  subscribePrefs,
} from "@/lib/player/player-prefs";

/**
 * Whether the precise (fine) scrubber is showing, remembered between visits.
 *
 * Off by default: the main bar is what a listener reaches for, and the
 * two-minute window is a deliberate disclosure for finding an exact spot.
 * Read through the shared external store so the server render and storage
 * cannot disagree, and so an open scrubber stays open across books.
 */
export function usePreciseSeek(): {
  preciseSeek: boolean;
  setPreciseSeek: (next: boolean) => void;
} {
  const preciseSeek = useSyncExternalStore(
    subscribePrefs,
    () => boolPrefSnapshot(PRECISE_SEEK_PREF_KEY, false),
    () => boolPrefServerSnapshot(false)
  );
  const setPreciseSeek = useCallback(
    (next: boolean) => setBoolPref(PRECISE_SEEK_PREF_KEY, next),
    []
  );
  return { preciseSeek, setPreciseSeek };
}
