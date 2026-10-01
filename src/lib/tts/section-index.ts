/**
 * Index-stable take-home helpers.
 *
 * Section `i` is a fixed slice of the once-split book. Playlist order,
 * storage paths, and concat order are always `0..N-1` — never the order
 * parallel Fish calls happen to finish.
 */

import type { InFlightGate } from "@/lib/tts/section-concurrency";
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

/** Indexes that still need audio — includes retry/failed holes. */
export function holeIndexes(segments: JobSegment[], total: number): number[] {
  const ready = readyIndexSet(segments);
  const out: number[] = [];
  for (let i = 0; i < total; i++) {
    if (!ready.has(i)) out.push(i);
  }
  return out;
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

function segmentByIndex(segments: JobSegment[]): Map<number, JobSegment> {
  return new Map(segments.map((s) => [s.index, s]));
}

/** Never-attempted indexes (not yet on the segment map). */
export function unattemptedIndexes(
  segments: JobSegment[],
  total: number
): number[] {
  const seen = segmentByIndex(segments);
  const out: number[] = [];
  for (let i = 0; i < total; i++) {
    if (!seen.has(i)) out.push(i);
  }
  return out;
}

/** First-pass failures eligible for one more hole retry. */
export function retryableHoleIndexes(
  segments: JobSegment[],
  total: number
): number[] {
  const byIndex = segmentByIndex(segments);
  const out: number[] = [];
  for (let i = 0; i < total; i++) {
    if (byIndex.get(i)?.status === "retry") out.push(i);
  }
  return out;
}

/**
 * Claim never-attempted indexes first. After the last index has been
 * tried, claim `retry` holes once. Permanently `failed` indexes stay skipped.
 */
export function claimableIndexes(
  segments: JobSegment[],
  total: number
): number[] {
  const first = unattemptedIndexes(segments, total);
  if (first.length > 0) return first;
  return retryableHoleIndexes(segments, total);
}

export function allIndexesReady(
  segments: JobSegment[],
  total: number
): boolean {
  if (total <= 0) return false;
  return lowestUnreadyIndex(segments, total) >= total;
}

/**
 * Absolute claim ceiling. Fish callers pass at most 5. Edge and Google
 * may pass 6–8. A larger request is clipped here.
 */
export const SECTION_FANOUT_HARD_MAX = 8;

/**
 * Claim the next set of indexes, up to `min(fanout, 8, remaining)`.
 *
 * The first tick of a new job claims `[0, 1, …]` so those sections start
 * together. Concat and playback still walk `0..N-1`.
 */
export function claimIndexSet(opts: {
  segments: JobSegment[];
  total: number;
  fanout: number;
}): number[] {
  const fanout = Math.max(1, Math.min(opts.fanout, SECTION_FANOUT_HARD_MAX));
  const pending = claimableIndexes(opts.segments, opts.total);
  if (pending.length === 0) return [];
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
  concurrency: number,
  gate?: InFlightGate
): Promise<Map<number, T>> {
  const results = new Map<number, T>();
  if (indexes.length === 0) return results;

  const cap = Math.max(
    1,
    Math.min(concurrency, SECTION_FANOUT_HARD_MAX, indexes.length)
  );
  let cursor = 0;

  async function worker() {
    while (true) {
      if (gate) await gate.acquire();
      const i = cursor;
      cursor += 1;
      const index = indexes[i];
      if (index === undefined) {
        gate?.release();
        return;
      }
      try {
        const value = await work(index);
        results.set(index, value);
      } finally {
        gate?.release();
      }
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

export function mostIndexesReady(
  segments: JobSegment[],
  total: number
): boolean {
  if (total <= 0) return false;
  const ready = readyCount(segments);
  return ready > 0 && ready >= Math.ceil(total / 2);
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
