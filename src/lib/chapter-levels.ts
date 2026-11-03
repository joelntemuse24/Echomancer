/**
 * Which outline entries are chapters and which are sub-sections.
 *
 * The player shows the top level as "Chapters". A book's printed sub-headings
 * are useful one level down — you can jump to "2.1 Model and Architectures" —
 * but listing them beside the chapters makes a 32-marker paper look like 32
 * chapters and a 340-marker report look like 340.
 *
 * The rule is the source's own evidence, in this order:
 *
 * 1. **A nested TOC already says.** If the source gave levels and more than one
 *    level exists, level 1 is the chapter list; deeper levels are children.
 * 2. **Sub-section numbering.** `2.1`, `4.3.2`, and `A.2` are sub-sections of
 *    `2`, `4`, and `A`. This is what a PDF outline that forgot its nesting and
 *    an HTML page of `h3`s both look like.
 * 3. **Shallower heading level.** `h1`/`h2` are chapters, `h3`-`h6` are
 *    children — the convention every HTML page and EPUB follows.
 * 4. **A Book/Part container.** A flat list that prints `Book Two` or `Part
 *    One` between the chapters is grouped: the containers are the chapters and
 *    everything under one is its child.
 *
 * A book with none of those stays flat: every entry is a chapter, because
 * inventing a hierarchy the source did not print would be worse than a long
 * list.
 */

import type { BlockOutlineEntry } from "@/lib/block-chapters";

/** `2.1`, `4.3.2`, `A.2`, `B.1.4` — a numbered sub-section label. */
const SUBSECTION_NUMBER_RE = /^(?:[A-H]|\d{1,3})(?:\.\d{1,2})+/;

/** A container line: `Book Two`, `Part One`, `Volume I`, `BOOK THE FIRST`. */
const CONTAINER_RE =
  /^(?:book|part|volume)\s+(?:the\s+)?(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|first|second|third|fourth|fifth|sixth)\b/i;

/** The numbered parent of a sub-section: `2.1` -> `2`, `A.2.1` -> `A`. */
export function parentNumberOf(title: string): string | null {
  const match = SUBSECTION_NUMBER_RE.exec(title.trim());
  if (!match) return null;
  return match[0].split(".")[0] ?? null;
}

/**
 * The chapter-number part of a heading, used to find a sub-section's parent.
 * `2 Method` -> `2`, `A Appendix` -> `A`, `Chapter 3` -> null (a label, not a
 * number prefix).
 */
export function chapterNumberOf(title: string): string | null {
  const match = /^(?:Section\s+)?([A-H]|\d{1,3})(?!\.\d)\b/i.exec(title.trim());
  return match?.[1]?.toUpperCase() ?? null;
}

/** True when the outline uses more than one level of its own. */
export function hasNestedLevels(entries: BlockOutlineEntry[]): boolean {
  const first = entries[0]?.level ?? 1;
  return entries.some((entry) => entry.level !== first);
}

/**
 * A container line and nothing else. `Book Two` is a container; `Book Two ·
 * Chapter I` is a chapter that carries its container's name, because
 * `withPartContextTitles` prefixed it.
 */
export function isContainerLine(title: string): boolean {
  const t = title.trim();
  const match = CONTAINER_RE.exec(t);
  if (!match) return false;
  // The rest is an era ("Book One: 1805") or nothing. A chapter label ("Book
  // Two · Chapter I") means this is a prefixed chapter title.
  const rest = t.slice(match[0].length).replace(/^[\s:,.–—-]+/, "");
  return !/\b(?:chapter|section|letter|act|scene|canto|stave)\b/i.test(rest);
}

/** True when the outline prints Book / Part / Volume containers. */
export function hasContainerLines(entries: BlockOutlineEntry[]): boolean {
  return entries.some((entry) => isContainerLine(entry.title));
}

/**
 * Re-level the entries so the top level is the chapter list.
 *
 * Returns a new array: `level: 1` entries are chapters and `level: 2` are their
 * children. Entries keep their order, and a child always follows the chapter it
 * belongs to.
 */
export function demoteSubsections(
  entries: BlockOutlineEntry[],
  opts?: { maxTopLevel?: number }
): BlockOutlineEntry[] {
  if (entries.length === 0) return entries;
  const maxTopLevel = opts?.maxTopLevel ?? 2;

  // 1. The source's own nesting. Normalise so the shallowest level becomes 1
  //    and anything deeper becomes 2.
  if (hasNestedLevels(entries)) {
    const min = Math.min(...entries.map((entry) => entry.level));
    return entries.map((entry) => ({
      ...entry,
      level: Math.min(maxTopLevel, Math.max(1, entry.level - min + 1)),
    }));
  }

  // 2. Sub-section numbering, when the parent is really in the list.
  const chapterNumbers = new Set<string>();
  for (const entry of entries) {
    const number = chapterNumberOf(entry.title);
    if (number) chapterNumbers.add(number);
  }
  const byNumber = entries.map((entry) => {
    const parent = parentNumberOf(entry.title);
    if (parent && chapterNumbers.has(parent.toUpperCase())) {
      return { ...entry, level: 2 };
    }
    return { ...entry, level: 1 };
  });
  if (byNumber.some((entry) => entry.level === 2)) return byNumber;

  // 3. The heading depth the source used.
  const byDepth = entries.map((entry) => ({
    ...entry,
    level: entry.level <= maxTopLevel ? 1 : 2,
  }));
  if (byDepth.some((entry) => entry.level === 2)) return byDepth;

  // 4. A flat list with Book/Part containers: the container is the chapter and
  //    everything until the next container is its child. A leading chapter with
  //    no container above it stays top-level (a Preface before Book One).
  if (hasContainerLines(entries)) {
    let inside = false;
    return entries.map((entry) => {
      if (isContainerLine(entry.title)) {
        inside = true;
        return { ...entry, level: 1 };
      }
      return { ...entry, level: inside ? 2 : 1 };
    });
  }

  return entries;
}

/**
 * Re-level and re-nest a resolved chapter tree.
 *
 * Applied once, on the finished document, so every detection path gets the same
 * answer: the top level is what the player lists as chapters, and anything the
 * source marked as a sub-heading hangs under it. A flat list that already
 * satisfies no rule comes back untouched.
 *
 * Levels are recomputed from titles (via `demoteSubsections`), then the list is
 * nested again from scratch — an existing partial tree is discarded, because the
 * children of a chapter must be contiguous in reading order.
 */
export function normaliseChapterLevels<T extends BookChapterLike>(chapters: T[]): T[] {
  if (chapters.length < 2) return chapters;
  const flat = flatten(chapters);
  const entries: BlockOutlineEntry[] = flat.map((chapter, index) => ({
    title: chapter.title,
    level: chapter.level,
    blockIndex: index,
  }));
  const levelled = demoteSubsections(entries);
  // Nothing to nest: keep the input exactly as it was.
  if (!levelled.some((entry) => entry.level > 1)) return chapters;
  const byTitle = new Map<number, number>();
  const levelOf = flat.map((chapter, index) => {
    const entry = levelled[index]!;
    byTitle.set(index, entry.level);
    return entry.level;
  });
  return nestFlat(flat, levelOf) as T[];
}

type BookChapterLike = {
  index: number;
  title: string;
  level: number;
  charStart: number;
  charEnd: number;
  children?: BookChapterLike[];
};

function flatten<T extends BookChapterLike>(chapters: T[]): T[] {
  const out: T[] = [];
  const walk = (nodes: T[]) => {
    for (const node of nodes) {
      const { children, ...rest } = node as T & { children?: T[] };
      void children;
      out.push({ ...(rest as T), children: undefined } as T);
      if (node.children?.length) walk(node.children as T[]);
    }
  };
  walk(chapters);
  return out;
}

function nestFlat<T extends BookChapterLike>(flat: T[], levels: number[]): T[] {
  const roots: T[] = [];
  const stack: T[] = [];
  for (let i = 0; i < flat.length; i++) {
    const level = levels[i] ?? 1;
    const node = { ...flat[i]!, level } as T;
    delete (node as T & { children?: T[] }).children;
    while (stack.length > 0 && (stack[stack.length - 1]!.level ?? 1) >= level) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.children = parent.children ?? [];
      (parent.children as T[]).push(node);
    } else {
      roots.push(node);
    }
    stack.push(node);
  }
  return roots;
}
