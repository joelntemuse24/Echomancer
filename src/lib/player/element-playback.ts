/**
 * Reading playback state from the one shared element.
 *
 * The player page is unmounted whenever the listener walks to Library, so any
 * media state it keeps in component state starts from scratch on re-entry. The
 * element in the root-layout shell does not: it is the same object, still
 * playing, and it fires no `play` event for a book that never stopped. A page
 * that trusts its own default therefore showed Play over playing audio, and its
 * tap called `play()` on an element that was already playing — which resolves
 * without changing anything, so the button looked dead.
 *
 * These helpers are the single rule for "is this element playing"; the page and
 * the shell both read it instead of keeping an opinion of their own.
 */

/** The facts this module needs, so it runs without a DOM. */
export interface ElementPlaybackFacts {
  paused: boolean;
  ended: boolean;
  readyState: number;
  error: { code: number } | null;
}

/**
 * The element is playing audio right now.
 *
 * `paused` alone is not enough: `ended` also leaves an element unpaused on some
 * engines, and a released element (`readyState` 0 with no source) must never
 * read as playing just because a stale `paused` flag says so.
 */
export function elementIsPlaying(audio: ElementPlaybackFacts | null | undefined): boolean {
  if (!audio) return false;
  if (audio.ended) return false;
  return !audio.paused;
}

/**
 * Two playback URLs point at the same file. A cache-busting `?r=n` added after
 * a media error, and the presigned query on a versioned URL, are not a
 * different book.
 */
export function samePlaybackSource(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const strip = (value: string) => value.split("?")[0] ?? "";
  return strip(a) !== "" && strip(a) === strip(b);
}

/**
 * The part whose URL the element currently holds, or null when the element is
 * on a single-file book (or on a file that is not one of the parts).
 */
export function partIndexForSrc(
  parts: readonly { index: number; url?: string }[],
  src: string | null | undefined
): number | null {
  if (!src) return null;
  for (const part of parts) {
    if (samePlaybackSource(part.url, src)) return part.index;
  }
  return null;
}

/** Element events that can change {@link elementIsPlaying}. */
export const PLAYBACK_STATE_EVENTS = [
  "play",
  "playing",
  "pause",
  "ended",
  "emptied",
  "loadedmetadata",
] as const;
