/**
 * Blocks → chapter outline.
 *
 * The structured path: a source that knows its own structure (EPUB nav/NCX,
 * an HTML page's `<h1>`–`<h6>`, a PDF outline, DOCX heading styles) names its
 * chapters as block indexes. This module turns that list into the
 * `chapters.json` shape, deriving character offsets from the speakable
 * projection so nothing has to search the prose afterwards.
 *
 * Rules that hold for every structured source:
 *
 * - The source's own TOC wins. It is the only thing that knows a book has 135
 *   chapters when its prose only spells out 71 of them in a contents page.
 * - Furniture is filtered: cover, title page, contents, copyright, licence,
 *   colophon, Gutenberg boilerplate. These name a page of the book's
 *   packaging, not a part of the book.
 * - Nesting comes from the source's own levels, never from title shape.
 * - When there is no usable TOC, the heading blocks themselves are the
 *   outline — still structural, never a guess at prose shape.
 */

import {
  chaptersForNarration,
  chapterDisplayTitle,
  CHAPTERS_VERSION,
  MAX_CHAPTERS,
  type BookChapter,
  type ChapterSource,
  type ChaptersDocument,
} from "@/lib/book-chapters";
import { isFurnitureHeading, type BookBlock } from "@/lib/blocks";

/** One chapter marker: a title plus the block it starts at. */
export type BlockOutlineEntry = {
  title: string;
  level: number;
  /** Index into the block list. */
  blockIndex: number;
};

/**
 * Drop TOC entries that name packaging rather than the book.
 *
 * A contents page lists "Contents" itself, a Gutenberg EPUB lists "Project
 * Gutenberg", and a Standard Ebooks file lists "Imprint", "Colophon" and
 * "Uncopyright". None of those is a chapter.
 *
 * The filter is deliberately conservative: an entry is only dropped when it
 * names furniture, so a book that genuinely has a "Preface" keeps it — and a
 * list that is *entirely* furniture is kept as-is rather than emptied.
 */
export function filterTocEntries<T extends { title: string }>(entries: T[]): T[] {
  if (entries.length <= 1) return entries;
  const kept = entries.filter((entry) => !isFurnitureHeading(entry.title));
  return kept.length > 0 ? kept : entries;
}

/**
 * A TOC is only the outline when most of it lands on real blocks.
 *
 * Project Gutenberg occasionally ships a per-paragraph NCX (Pride and
 * Prejudice has 516 `navPoint`s for 61 chapters), and its fragments point at
 * anchors that are not in the body. A list that mostly resolves is a real
 * chapter list; one that mostly does not is noise, and the heading blocks make
 * a better outline.
 */
export const MIN_TOC_RESOLUTION = 0.5;

export function tocResolution(
  entries: BlockOutlineEntry[],
  blockStart: number[]
): number {
  if (entries.length === 0) return 0;
  let resolved = 0;
  for (const entry of entries) {
    const at = blockStart[entry.blockIndex];
    if (typeof at === "number" && at >= 0) resolved += 1;
  }
  return resolved / entries.length;
}

/** Sort by position, keeping the source's order for entries at the same block. */
function ordered(entries: BlockOutlineEntry[]): BlockOutlineEntry[] {
  return entries
    .map((entry, i) => ({ entry, i }))
    .filter(({ entry }) => Number.isInteger(entry.blockIndex) && entry.blockIndex >= 0)
    .sort((a, b) => a.entry.blockIndex - b.entry.blockIndex || a.i - b.i)
    .map(({ entry }) => entry);
}

/**
 * Two markers at the same block would give the first a zero-length body. A
 * deeper entry at the same block is a sub-heading of the same line, so the
 * shallower one is the one a listener expects to see.
 */
function dedupe(entries: BlockOutlineEntry[]): BlockOutlineEntry[] {
  const out: BlockOutlineEntry[] = [];
  for (const entry of entries) {
    const previous = out[out.length - 1];
    if (previous && previous.blockIndex === entry.blockIndex) {
      if (entry.level < previous.level) out[out.length - 1] = entry;
      continue;
    }
    out.push(entry);
  }
  return out;
}

type Placed = { entry: BlockOutlineEntry; chapter: BookChapter };

/** Nest a flat list by its own levels, the way the source printed them. */
function nest(placed: Placed[]): BookChapter[] {
  const roots: BookChapter[] = [];
  const stack: BookChapter[] = [];
  for (const { chapter } of placed) {
    const node: BookChapter = { ...chapter };
    delete node.children;
    while (stack.length > 0 && stack[stack.length - 1]!.level >= node.level) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.children = parent.children ?? [];
      parent.children.push(node);
    } else {
      roots.push(node);
    }
    stack.push(node);
  }
  return roots;
}

/**
 * A TOC can nest a numbered title and its own body heading ("I. A SCANDAL IN
 * BOHEMIA" containing "I."). Those bare numerals are the chapter's number set
 * on its own line, not chapters — Project Gutenberg's EPUB build produces them
 * for Sherlock Holmes, and keeping them split twelve stories into fifteen
 * entries.
 *
 * The rule only fires under a *titled* parent. A bare numeral under a
 * container ("Part I" containing "II") is a real chapter, and a book numbered
 * only by ordinal (The Time Machine's "I", "II", "III") has no such parent at
 * all, so both keep theirs.
 */
const CONTAINER_LABEL_RE = /^(?:part|book|volume|act|canto|stave|scene)\b/i;

function dropBareOrdinalChildren(entries: BlockOutlineEntry[]): BlockOutlineEntry[] {
  const ancestorTitles: string[] = [];
  return entries.filter((entry) => {
    while (ancestorTitles.length >= entry.level) ancestorTitles.pop();
    const bare = /^(?:\d{1,3}|[IVXLCDM]{1,12})\.?$/i.test(entry.title.trim());
    const parent = ancestorTitles[ancestorTitles.length - 1];
    const keep = !bare || !parent || CONTAINER_LABEL_RE.test(parent);
    if (!bare) ancestorTitles.push(entry.title);
    else if (keep) ancestorTitles.push(entry.title);
    return keep;
  });
}

/**
 * Turn TOC entries into a `chapters.json` document.
 *
 * `blockStart[i]` is block i's offset in `spoken`, or -1 when the block
 * narrated to nothing. A marker that lands on a -1 block snaps forward to the
 * next block that has words, so a heading whose own text was dropped still
 * opens the chapter it introduced.
 */
export function chaptersFromBlockOutline(
  spoken: string,
  blockStart: number[],
  entries: BlockOutlineEntry[],
  source: ChapterSource,
  opts?: { blocks?: BookBlock[] }
): ChaptersDocument {
  if (!spoken.trim() || entries.length === 0) {
    return { version: CHAPTERS_VERSION, source: "none", chapters: [] };
  }
  const usable = dedupe(ordered(filterTocEntries(dropBareOrdinalChildren(entries))))
    .map((entry) => ({ ...entry, blockIndex: snapForward(blockStart, entry.blockIndex) }))
    .filter((entry) => entry.blockIndex >= 0);
  if (usable.length === 0) {
    return { version: CHAPTERS_VERSION, source: "none", chapters: [] };
  }

  const placed: Placed[] = usable.map((entry) => ({
    entry,
    chapter: {
      index: 0,
      title: chapterDisplayTitle(entry.title),
      level: Math.max(1, Math.round(entry.level)),
      charStart: blockStart[entry.blockIndex]!,
      charEnd: spoken.length,
      match: entry.title.replace(/\s+/g, " ").trim(),
    },
  }));

  // The source named these headings itself, so shape filters must not drop
  // "2.1 Subscriptions" for looking like a scrap.
  const keptStarts = new Set(
    chaptersForNarration(
      placed.map((row) => row.chapter),
      spoken,
      { trusted: true }
    ).map((chapter) => chapter.charStart)
  );
  const kept = dropEmptyFrontCopy(placed.filter((row) => keptStarts.has(row.chapter.charStart)));
  if (kept.length === 0) {
    return { version: CHAPTERS_VERSION, source: "none", chapters: [] };
  }
  return {
    version: CHAPTERS_VERSION,
    source,
    chapters: finishTree(nest(kept), spoken.length),
  };
}

/**
 * A half-title page repeats the book's name a page before the real title
 * page, so an outline can open with "Moby Dick" twice, the first one covering
 * nothing. Drop a marker whose span holds no prose when a later marker has the
 * same title — the later copy is the one with the book under it.
 */
function dropEmptyFrontCopy(placed: Placed[]): Placed[] {
  const out: Placed[] = [];
  for (let i = 0; i < placed.length; i++) {
    const row = placed[i]!;
    const next = placed[i + 1];
    const empty = next ? next.chapter.charStart - row.chapter.charStart < 4 : false;
    if (empty) {
      const key = row.chapter.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      const repeated = placed
        .slice(i + 1)
        .some(
          (later) =>
            later.chapter.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() === key
        );
      if (repeated) continue;
    }
    out.push(row);
  }
  return out;
}

function snapForward(blockStart: number[], from: number): number {
  for (let i = Math.max(0, from); i < blockStart.length; i++) {
    if (blockStart[i]! >= 0) return i;
  }
  return -1;
}

function finishTree(nodes: BookChapter[], end: number): BookChapter[] {
  const capped = nodes.slice(0, MAX_CHAPTERS);
  for (let i = 0; i < capped.length; i++) {
    const nextStart = capped[i + 1]?.charStart ?? end;
    const nested = capped[i]!.children?.length
      ? finishTree(capped[i]!.children!, nextStart)
      : undefined;
    const node: BookChapter = {
      ...capped[i]!,
      index: i,
      charEnd: nextStart,
      ...(nested && nested.length > 0 ? { children: nested } : {}),
    };
    if (!nested?.length) delete node.children;
    capped[i] = node;
  }
  return capped;
}

/**
 * An outline label that swallowed the last line of the chapter before it —
 * "I hope Mr. Bingley will like it. CHAPTER II." — names the chapter after the
 * sentence, not the sentence. A trailing chapter/part marker is the title.
 */
export function trimTrailingChapterLabel(title: string): string {
  const t = title.replace(/\s+/g, " ").trim();
  const match = /\b((?:chapter|part|book|volume|section|letter|act|scene|stave|canto)\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\b[.:]?)\s*$/i.exec(
    t
  );
  if (!match || match.index === 0) return t;
  const label = match[1]!.trim();
  // Only when there is a real sentence in front of it; a title that simply
  // ends in "Book Two" is the container's own name.
  if (t.length - label.length < 12) return t;
  return label;
}
