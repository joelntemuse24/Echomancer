/**
 * Player preferences that outlive a visit: whether the read-along follows
 * the audio, whether it opens in focus (full-screen) mode, whether the
 * precise (fine) scrubber is showing, and the chosen listen-time speed.
 *
 * A `Storage` that throws (private mode, disabled cookies) is treated as
 * absent, so the player never fails to open over a preference. Values read
 * through here are also mirrored in memory, so a component that changed one
 * during this visit keeps it even when the write was refused.
 *
 * Speed is stored as a number string. It is per browser, not per book: a
 * listener who chose 1.2x keeps it when the next book opens and after a
 * reload. That deliberately replaces the older "a reload starts at 1x" rule.
 */

export const FOLLOW_PREF_KEY = "ec-read-along-follow";
export const FULLSCREEN_PREF_KEY = "ec-read-along-fullscreen";
/** The precise scrubber is a disclosure: off unless the listener opens it. */
export const PRECISE_SEEK_PREF_KEY = "ec-player-precise-seek";
/** Listen-time playbackRate, global across books. */
export const SPEED_PREF_KEY = "ec-player-speed";

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

/** A numeric preference, or the fallback for a missing or unparsable value. */
export function readNumberPref(store: PrefStore, key: string, fallback: number): number {
  if (!store) return fallback;
  try {
    const raw = store.getItem(key);
    if (raw == null || raw.trim() === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function writeNumberPref(store: PrefStore, key: string, value: number): void {
  if (!store) return;
  try {
    store.setItem(key, String(value));
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

/** Stored as the same `1` / `0` / number-string shape the writers produce. */
const memory = new Map<string, string>();
const listeners = new Set<() => void>();

export function subscribePrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function rememberRaw(key: string, value: string | null): void {
  if (value == null) memory.delete(key);
  else memory.set(key, value);
}

/** The value a component should render right now. */
export function boolPrefSnapshot(key: string, fallback: boolean): boolean {
  const remembered = memory.get(key);
  if (remembered === "1") return true;
  if (remembered === "0") return false;
  return readBoolPref(browserPrefStore(), key, fallback);
}

/** The value the server rendered, before storage is readable. */
export function boolPrefServerSnapshot(fallback: boolean): boolean {
  return fallback;
}

/** Remember a preference and re-render everyone watching it. */
export function setBoolPref(key: string, value: boolean): void {
  rememberRaw(key, value ? "1" : "0");
  writeBoolPref(browserPrefStore(), key, value);
  listeners.forEach((listener) => listener());
}

/** A numeric preference, mirrored in memory like the booleans. */
export function numberPrefSnapshot(key: string, fallback: number): number {
  const remembered = memory.get(key);
  if (remembered != null) {
    const value = Number(remembered);
    if (Number.isFinite(value)) return value;
  }
  return readNumberPref(browserPrefStore(), key, fallback);
}

export function numberPrefServerSnapshot(fallback: number): number {
  return fallback;
}

export function setNumberPref(key: string, value: number): void {
  rememberRaw(key, String(value));
  writeNumberPref(browserPrefStore(), key, value);
  listeners.forEach((listener) => listener());
}

/** Test seam: forget what this module remembers without touching storage. */
export function resetPrefMemoryForTests(): void {
  memory.clear();
}
