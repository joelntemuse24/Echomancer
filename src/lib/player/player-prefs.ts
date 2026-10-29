/**
 * Player preferences that outlive a visit: whether the read-along follows
 * the audio, whether it opens in focus (full-screen) mode, and whether the
 * precise (fine) scrubber is showing.
 *
 * A `Storage` that throws (private mode, disabled cookies) is treated as
 * absent, so the player never fails to open over a preference. Values read
 * through here are also mirrored in memory, so a component that changed one
 * during this visit keeps it even when the write was refused.
 */

export const FOLLOW_PREF_KEY = "ec-read-along-follow";
export const FULLSCREEN_PREF_KEY = "ec-read-along-fullscreen";
/** The precise scrubber is a disclosure: off unless the listener opens it. */
export const PRECISE_SEEK_PREF_KEY = "ec-player-precise-seek";

export type PrefStore = Pick<Storage, "getItem" | "setItem"> | null;

export function readBoolPref(store: PrefStore, key: string, fallback: boolean): boolean {
  if (!store) return fallback;
  try {
    const value = store.getItem(key);
    if (value === "1") return true;
    if (value === "0") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

export function writeBoolPref(store: PrefStore, key: string, value: boolean): void {
  if (!store) return;
  try {
    store.setItem(key, value ? "1" : "0");
  } catch {
    // The in-memory value still holds for this visit.
  }
}

/** The browser's localStorage, or null on the server and where it is blocked. */
export function browserPrefStore(): PrefStore {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const memory = new Map<string, boolean>();
const listeners = new Set<() => void>();

export function subscribePrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The value a component should render right now. */
export function boolPrefSnapshot(key: string, fallback: boolean): boolean {
  const remembered = memory.get(key);
  if (remembered != null) return remembered;
  return readBoolPref(browserPrefStore(), key, fallback);
}

/** The value the server rendered, before storage is readable. */
export function boolPrefServerSnapshot(fallback: boolean): boolean {
  return fallback;
}

/** Remember a preference and re-render everyone watching it. */
export function setBoolPref(key: string, value: boolean): void {
  memory.set(key, value);
  writeBoolPref(browserPrefStore(), key, value);
  listeners.forEach((listener) => listener());
}
