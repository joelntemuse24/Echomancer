/**
 * The listening position saved by the root-layout shell.
 *
 * The player page owns the paced save while it is mounted, because it also
 * writes the server row (with the compare-and-swap version that keeps two
 * devices from clobbering each other). Once the listener walks to Library and
 * keeps listening — the mini-player case — there is no page left to run that
 * clock, so the stored position froze at the moment of navigation and closing
 * the browser reopened at that stale spot.
 *
 * The shell therefore keeps the local copy moving on its own. It writes the
 * same `ec-resume:<jobId>` row the page writes, in the same shape:
 * `positionSeconds` on the book clock and `sectionIndex: null`, because the
 * element's clock plus the current part's offset *is* the book clock. It does
 * not touch the server row; the page merges that on the next open.
 *
 * `updatedAt` is a wall-clock second, the same scale the server stamps, so
 * `preferResume` still treats the fresher copy as the winner.
 */

import type { PrefStore } from "@/lib/player/player-prefs";
import {
  readStoredResume,
  writeStoredResume,
  type StoredResume,
} from "@/lib/player/playback-position";

/** Element time → book clock. A part file starts at its part's offset. */
export function shellBookSeconds(input: {
  elementSeconds: number;
  elementOffset: number;
}): number {
  const element = Number.isFinite(input.elementSeconds) ? Math.max(0, input.elementSeconds) : 0;
  const offset = Number.isFinite(input.elementOffset) ? Math.max(0, input.elementOffset) : 0;
  return element + offset;
}

/**
 * True when this element has a playhead worth storing. A source that was just
 * assigned reports 0 with no metadata, and that 0 is a load, not a listen.
 */
export function shellPositionIsStorable(input: {
  bookSeconds: number;
  readyState: number;
}): boolean {
  if (!Number.isFinite(input.bookSeconds) || input.bookSeconds <= 0.5) return false;
  return input.readyState > 0;
}

/**
 * Store the shell's playhead. Returns the row written, or null when there is
 * nothing safe to store. The previous `updatedAt` is replaced by `now`, so a
 * later open prefers this position over an older server row.
 */
export function saveShellResume(
  store: PrefStore,
  input: {
    jobId: string;
    elementSeconds: number;
    elementOffset: number;
    readyState: number;
    /** Unix seconds. Injected so the row is testable without a clock. */
    nowSeconds: number;
  }
): StoredResume | null {
  const bookSeconds = shellBookSeconds(input);
  if (!shellPositionIsStorable({ bookSeconds, readyState: input.readyState })) return null;
  const row: StoredResume = {
    positionSeconds: bookSeconds,
    sectionIndex: null,
    updatedAt: Math.floor(input.nowSeconds),
  };
  writeStoredResume(store, input.jobId, row);
  return row;
}

/**
 * The position a paused tab should come back to. Same rule as
 * {@link saveShellResume} but reads instead of writes, so the shell can decide
 * whether a lock-screen Play needs the restore at all.
 */
export function storedShellResume(store: PrefStore, jobId: string): StoredResume | null {
  return readStoredResume(store, jobId);
}
