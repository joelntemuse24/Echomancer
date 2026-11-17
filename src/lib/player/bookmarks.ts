/**
 * One-tap playhead marks. A bookmark is a position on this listener's copy
 * of a book. There is no note.
 */

import { formatPlayClock } from "@/lib/player/seek";

/** A second tap this close to an existing mark, on the same clock, is that mark. */
export const BOOKMARK_DEDUPE_SECONDS = 2;

/** How long the player shows "Saved" / "Already saved". */
export const BOOKMARK_NOTICE_MS = 1600;

export const BOOKMARK_LABEL_MAX = 120;
export const BOOKMARK_SNIPPET_MAX = 96;

export interface JobBookmark {
  id: string;
  positionSeconds: number;
  sectionIndex: number | null;
  label: string | null;
  createdAt: number;
}

export interface SaveBookmarkInput {
  positionSeconds: number;
  sectionIndex: number | null;
  label: string | null;
}

export type BookmarkNotice = "saved" | "duplicate" | "error";

export const BOOKMARK_NOTICE_TEXT: Record<BookmarkNotice, string> = {
  saved: "Saved",
  duplicate: "Already saved",
  error: "Couldn't save bookmark",
};

export function cleanBookmarkLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.slice(0, BOOKMARK_LABEL_MAX);
}

/**
 * A short slice of the passage already on screen. Callers pass blocks the
 * player has loaded; this does not fetch the book.
 */
export function passageSnippet(
  blocks: ReadonlyArray<{ text: string; charStart: number; charEnd: number }>,
  charIndex: number
): string | null {
  if (!Number.isFinite(charIndex) || blocks.length === 0) return null;
  const block = blocks.find(
    (item) => charIndex >= item.charStart && charIndex < item.charEnd
  );
  if (!block) return null;
  const text = block.text.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.slice(0, BOOKMARK_SNIPPET_MAX);
}

/** Prefer the words under the playhead. A chapter name is the fallback. */
export function bookmarkLabel(input: {
  passage?: string | null;
  chapterTitle?: string | null;
}): string | null {
  return cleanBookmarkLabel(input.passage) ?? cleanBookmarkLabel(input.chapterTitle);
}

export function bookmarksAreDuplicates(
  a: { positionSeconds: number; sectionIndex: number | null },
  b: { positionSeconds: number; sectionIndex: number | null }
): boolean {
  const aSection = a.sectionIndex ?? null;
  const bSection = b.sectionIndex ?? null;
  if (aSection !== bSection) return false;
  if (!Number.isFinite(a.positionSeconds) || !Number.isFinite(b.positionSeconds)) {
    return false;
  }
  return Math.abs(a.positionSeconds - b.positionSeconds) <= BOOKMARK_DEDUPE_SECONDS;
}

/** Full-file marks first, then each part, earliest playhead first. */
export function sortBookmarks<T extends { sectionIndex: number | null; positionSeconds: number }>(
  rows: readonly T[]
): T[] {
  return [...rows].sort((a, b) => {
    const aSection = a.sectionIndex ?? -1;
    const bSection = b.sectionIndex ?? -1;
    if (aSection !== bSection) return aSection - bSection;
    return a.positionSeconds - b.positionSeconds;
  });
}

export function withSavedBookmark(rows: readonly JobBookmark[], bookmark: JobBookmark): JobBookmark[] {
  const next = rows.some((row) => row.id === bookmark.id) ? rows : [...rows, bookmark];
  return sortBookmarks(next);
}

export function withoutBookmark(rows: readonly JobBookmark[], id: string): JobBookmark[] {
  return rows.filter((row) => row.id !== id);
}

/** Clock the list shows. A section file's clock is named so two 0:12 marks differ. */
export function bookmarkPlaceLabel(bookmark: {
  positionSeconds: number;
  sectionIndex: number | null;
}): string {
  const clock = formatPlayClock(bookmark.positionSeconds);
  if (bookmark.sectionIndex == null) return clock;
  return `Part ${bookmark.sectionIndex + 1} · ${clock}`;
}
