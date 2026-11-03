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
 * A container page (a part title, a book's own title) holds only its own
 * heading before the first child starts. It is still a real marker, but what
 * sits between it and its first child is a title page, so that span belongs to
 * the child, not to the container.
 *
 * Only when the container *has* such a span: a part with real prose under it
 * before the next chapter keeps that prose.
 */
function dropContainerTitlePages(placed: Placed[], spoken: string): Placed[] {
  const out: Placed[] = [];
  for (let i = 0; i < placed.length; i++) {
    const row = placed[i]!;
    const child = placed[i + 1];
    const isContainer = child && child.entry.level > row.entry.level;
    if (isContainer) {
      const span = spoken.slice(row.chapter.charStart, child.chapter.charStart).trim();
      const lines = span.split(/\n\s*\n/).map((line) => line.trim()).filter(Boolean);
      const titlePage =
        lines.length > 0 &&
        lines.length <= 4 &&
        span.length <= 200 &&
        !lines.some((line) => line.length > 80 || /[.!?]\s+\p{Lu}/u.test(line));
      if (titlePage) {
        out.push({ ...row, chapter: { ...row.chapter, charEnd: child.chapter.charStart } });
        continue;
      }
    }
    out.push(row);
  }
  return out;
}

/**
 * Which outline a structured source gets.
 *
 * The source's own TOC is preferred — it is the only thing that knows a book
 * has 135 chapters when its prose spells out only 71. But some EPUBs ship a
 * broken or per-paragraph TOC (Project Gutenberg's Pride and Prejudice
 * declares 516 `navPoint`s for 61 chapters, and most of its fragments point at
 * anchors that are not in the body). When the TOC resolves to *fewer* markers
 * than the book's own heading blocks, it is losing chapters, so the headings
 * are the better outline.
 */
export const MIN_TOC_HEADING_RATIO = 0.9;

export function chooseOutline(
  tocOutline: BlockOutlineEntry[],
  headingOutline: BlockOutlineEntry[],
  blockStart: number[]
): BlockOutlineEntry[] {
  if (tocOutline.length < 2) return headingOutline;
  if (headingOutline.length < 2) return tocOutline;
  if (tocDistinctRatio(tocOutline, blockStart) < MIN_TOC_DISTINCT) return headingOutline;
  const resolved = tocOutline.filter((entry) => (blockStart[entry.blockIndex] ?? -1) >= 0);
  if (resolved.length < headingOutline.length * MIN_TOC_HEADING_RATIO) {
    return headingOutline;
  }
  return tocOutline;
}

/**
 * A TOC is only the outline when its entries land on distinct places.
 *
 * Project Gutenberg sometimes builds a per-paragraph NCX (Pride and Prejudice
 * ships 516 `navPoint`s for 61 chapters) whose fragments point at anchors that
 * are not in the body, so most of them collapse onto one block. A real chapter
 * list resolves to roughly one block per entry; a per-paragraph list does not.
 */
export const MIN_TOC_DISTINCT = 0.5;

export function tocDistinctRatio(
  entries: BlockOutlineEntry[],
  blockStart: number[]
): number {
  const resolved = entries.filter((entry) => {
    const at = blockStart[entry.blockIndex];
    return typeof at === "number" && at >= 0;
  });
  if (resolved.length === 0) return 0;
  const distinct = new Set(resolved.map((entry) => blockStart[entry.blockIndex]));
  return distinct.size / resolved.length;
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
 * Two markers at the same block would give the first a zero-length body.
 *
 * When several labels land on one block the block's own text decides: the
 * label that matches the heading printed there is the chapter, and the others
 * are a title page or a container that happens to start on the same line.
 * Failing that, the shallower entry wins — that is what a listener expects to
 * see in the list.
 */
function dedupe(entries: BlockOutlineEntry[], blocks?: BookBlock[]): BlockOutlineEntry[] {
  const out: BlockOutlineEntry[] = [];
  for (const entry of entries) {
    const previous = out[out.length - 1];
    if (previous && previous.blockIndex === entry.blockIndex) {
      const printed = titleKey(blocks?.[entry.blockIndex]?.text ?? "");
      const previousMatches = printed.length > 0 && titleKey(previous.title) === printed;
      const entryMatches = printed.length > 0 && titleKey(entry.title) === printed;
      if (previousMatches && !entryMatches) continue;
      if (entryMatches && !previousMatches) out[out.length - 1] = entry;
      else if (previous.level < entry.level) continue;
      else if (entry.level < previous.level) out[out.length - 1] = entry;
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
 * How much prose a heading must have under it to count as a section of its own.
 * Below this, a run of headings is a contents table.
 */
const REAL_BODY_CHARS = 200;
/** A run this long of headings with no prose under them is a contents table. */
const CONTENTS_RUN = 5;

/**
 * Drop a contents table that the source marked up as headings.
 *
 * Project Gutenberg's HTML build prints its contents page with real `<h2>`
 * elements, so a page that lists 61 chapters arrives as 61 heading blocks with
 * nothing between them — followed by the same 61 headings with the prose. A
 * heading with prose under it is body; a run of five or more with almost none
 * is the table.
 */
function dropContentsTable(placed: Placed[], spoken: string): Placed[] {
  const bodySize = placed.map((row, i) => {
    const end = placed[i + 1]?.chapter.charStart ?? spoken.length;
    return Math.max(0, end - row.chapter.charStart);
  });
  const drop = new Set<number>();
  let i = 0;
  while (i < placed.length) {
    if (bodySize[i]! >= REAL_BODY_CHARS) {
      i += 1;
      continue;
    }
    let end = i;
    while (end < placed.length && bodySize[end]! < REAL_BODY_CHARS) end += 1;
    if (end - i >= CONTENTS_RUN) {
      for (let j = i; j < end; j++) drop.add(j);
      // The table's last row absorbs the first body paragraph as its span, so
      // it looks like a real section. Keep it only when its title repeats.
      const trailing = end;
      if (trailing < placed.length) {
        const key = titleKey(placed[trailing]!.chapter.title);
        const repeated = placed
          .slice(0, i)
          .some((row) => titleKey(row.chapter.title) === key);
        if (!repeated) drop.add(trailing);
      }
    }
    i = Math.max(end, i + 1);
  }
  if (drop.size === 0) return placed;
  return placed.filter((_, index) => !drop.has(index));
}

/**
 * A chapter label and an editorial summary can sit next to each other with no
 * prose between them ("CHAPTER II." then "I hope Mr. Bingley will like it." —
 * Project Gutenberg prints the summary as its own heading). One of them is the
 * chapter; the other is its deck.
 *
 * Keep the structural label when exactly one of the pair is one, else keep the
 * first: a chapter must not be split in two by its own subtitle.
 */
const STRUCTURAL_LABEL_RE =
  /^(?:chapter|part|book|volume|section|act|scene|letter|stave|canto|prologue|epilogue|preface|introduction|foreword|afterword|appendix|notes|endnotes)\b/i;

function mergeAdjacentHeadings(placed: Placed[], spoken: string): Placed[] {
  const out: Placed[] = [];
  for (const row of placed) {
    const previous = out[out.length - 1];
    // Only siblings merge. A part's own title page sits between the part and
    // its first chapter, and that is a container, not a subtitle.
    if (previous && previous.entry.level === row.entry.level) {
      const between = spoken.slice(previous.chapter.charStart, row.chapter.charStart).trim();
      const titleOnly = between.replace(/\s+/g, " ").length <= previous.chapter.title.length + 8;
      if (titleOnly) {
        const previousStructural = STRUCTURAL_LABEL_RE.test(previous.chapter.title);
        const rowStructural = STRUCTURAL_LABEL_RE.test(row.chapter.title);
        if (previousStructural && !rowStructural) continue;
        if (!previousStructural && rowStructural) {
          out[out.length - 1] = row;
          continue;
        }
        // Neither (or both) is structural: the first is the chapter title and
        // the second is its subtitle, so the first stays.
        continue;
      }
    }
    out.push(row);
  }
  return out;
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
  const usable = dedupe(
    ordered(filterTocEntries(dropBareOrdinalChildren(entries))),
    opts?.blocks
  )
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
  const narrated = placed.filter((row) => keptStarts.has(row.chapter.charStart));
  const kept = dropContentsTable(
    mergeAdjacentHeadings(
      dropContainerTitlePages(
        dropEmptyFrontCopy(narrated, spoken),
        spoken
      ),
      spoken
    ),
    spoken
  );
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
 * A half-title page repeats the book's name a page before the real title page,
 * so an outline can open with "Moby Dick" twice with only the half-title's own
 * line between them. Drop a marker whose span holds no prose when a later
 * marker has the same title — the later copy is the one with the book under it.
 *
 * The span is measured as the distance to the next *kept* marker, so a dropped
 * duplicate does not hide the prose under the copy that follows it.
 */
function dropEmptyFrontCopy(placed: Placed[], spoken: string): Placed[] {
  const out: Placed[] = [];
  const counts = new Map<string, number>();
  for (const row of placed) {
    const key = titleKey(row.chapter.title);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (let i = 0; i < placed.length; i++) {
    const row = placed[i]!;
    const key = titleKey(row.chapter.title);
    const next = placed[i + 1];
    if ((counts.get(key) ?? 0) > 1 && next) {
      const between = spoken.slice(row.chapter.charStart, next.chapter.charStart).trim();
      if (between.length < 120) {
        counts.set(key, (counts.get(key) ?? 1) - 1);
        continue;
      }
    }
    out.push(row);
  }
  return out;
}

function titleKey(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
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
