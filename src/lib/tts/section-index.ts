/**
 * Index-stable take-home helpers.
 *
 * Section `i` is a fixed slice of the once-split book. Playlist order,
 * storage paths, and concat order are always `0..N-1` — never the order
 * parallel Fish calls happen to finish.
 */

import type { JobSegment } from "@/lib/tts/types";

export function padSectionIndex(index: number): string {
  return String(index).padStart(4, "0");
}

export function sectionObjectName(index: number, extension: string): string {
  return `sections/${padSectionIndex(index)}.${extension}`;
}

export function parseSegmentMap(json: string | null | undefined): JobSegment[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is JobSegment => {
        return (
          Boolean(s) &&
          typeof s === "object" &&
          typeof (s as JobSegment).index === "number"
        );
      })
      .sort((a, b) => a.index - b.index);
  } catch {
    return [];
  }
}

export function upsertSegment(
  segments: JobSegment[],
  segment: JobSegment
): JobSegment[] {
  return [...segments.filter((s) => s.index !== segment.index), segment].sort(
    (a, b) => a.index - b.index
  );
}

export function readyIndexSet(segments: JobSegment[]): Set<number> {
  return new Set(
    segments.filter((s) => s.status === "ready" && s.path).map((s) => s.index)
  );
}

export function readyCount(segments: JobSegment[]): number {
  return readyIndexSet(segments).size;
}

/** Lowest index in `0..total-1` that is not yet ready. `total` if none. */
export function lowestUnreadyIndex(
  segments: JobSegment[],
  total: number
): number {
  const ready = readyIndexSet(segments);
  for (let i = 0; i < total; i++) {
    if (!ready.has(i)) return i;
  }
  return total;
}

/** Unready indexes in order, holes first. */
export function unreadyIndexes(
  segments: JobSegment[],
  total: number
): number[] {
  const ready = readyIndexSet(segments);
  const out: number[] = [];
  for (let i = 0; i < total; i++) {
    if (!ready.has(i)) out.push(i);
  }
  return out;
}

export function allIndexesReady(
  segments: JobSegment[],
  total: number
): boolean {
  if (total <= 0) return false;
  return lowestUnreadyIndex(segments, total) >= total;
}

/**
 * Claim the next set of indexes.
 *
 * Section 0 (and 1 when present) are claimed alone before the rest of the
 * fan-out so the player can start `0000` after one Fish round-trip.
 */
export function claimIndexSet(opts: {
  segments: JobSegment[];
  total: number;
  fanout: number;
  prioritizeZero?: boolean;
}): number[] {
  const fanout = Math.max(1, Math.min(opts.fanout, 5));
  const pending = unreadyIndexes(opts.segments, opts.total);
  if (pending.length === 0) return [];

  const prioritize = opts.prioritizeZero !== false;
  if (prioritize && pending[0] === 0) {
    const first: number[] = [0];
    if (pending.includes(1) && fanout >= 2) first.push(1);
    return first;
  }

  return pending.slice(0, fanout);
}

/** After claiming `claimed`, the lowest index not yet claimed. */
export function lowestUnclaimedAfter(
  segments: JobSegment[],
  total: number,
  claimed: number[]
): number {
  const claimedSet = new Set(claimed);
  const ready = readyIndexSet(segments);
  for (let i = 0; i < total; i++) {
    if (!ready.has(i) && !claimedSet.has(i)) return i;
  }
  return total;
}

/**
 * Bind each unit of work to an index *before* it starts. Results are stored
 * by index, never by completion order.
 */
export async function runIndexBoundFanout<T>(
  indexes: number[],
  work: (index: number) => Promise<T>,
  concurrency: number
): Promise<Map<number, T>> {
  const results = new Map<number, T>();
  if (indexes.length === 0) return results;

  const cap = Math.max(1, Math.min(concurrency, 5, indexes.length));
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor;
      cursor += 1;
      const index = indexes[i];
      if (index === undefined) return;
      const value = await work(index);
      results.set(index, value);
    }
  }

  await Promise.all(Array.from({ length: cap }, () => worker()));
  return results;
}

/** Concat / playlist walk: indexes in order. Throws if any gap. */
export function orderedReadyIndexes(
  segments: JobSegment[],
  total: number
): number[] {
  if (!allIndexesReady(segments, total)) {
    throw new Error(
      `Cannot concat: missing section indexes (ready ${readyCount(segments)}/${total})`
    );
  }
  return Array.from({ length: total }, (_, i) => i);
}

export function concatTranscript(
  segments: JobSegment[],
  total: number
): number[] {
  return orderedReadyIndexes(segments, total);
}

/** Play index `i` only when every earlier index is ready. */
export function canPlayIndex(
  segments: JobSegment[],
  index: number
): boolean {
  if (index < 0) return false;
  const ready = readyIndexSet(segments);
  for (let i = 0; i <= index; i++) {
    if (!ready.has(i)) return false;
  }
  return true;
}

/** First playable index is always 0, or nothing. */
export function firstPlayableIndex(segments: JobSegment[]): number | null {
  return canPlayIndex(segments, 0) ? 0 : null;
}

/** Next playable after `current`, or null if we must wait. */
export function nextPlayableIndex(
  segments: JobSegment[],
  current: number
): number | null {
  const next = current + 1;
  return canPlayIndex(segments, next) ? next : null;
}

export function createAsyncMutex() {
  let tail: Promise<void> = Promise.resolve();
  return async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const prev = tail;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}
