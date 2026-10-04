/**
 * Chapter outline stored next to `content.txt`.
 *
 * Offsets are JavaScript string indexes into the speakable `content.txt`.
 * Detection failure is an empty `source: "none"` document, never a failed upload.
 */

import { chaptersFromPrintedToc, isBodyHeadingBlock } from "@/lib/printed-toc";
import {
  isAcademicNumberedHeading,
  isBookOrVolumeLine,
  isContentsEntryLine,
  playbackHeadingFlags,
} from "@/lib/tts/speakable-text";
import {
  isAllCapsTitleLine,
  toTitleCase,
} from "@/lib/tts/normalize-speakable";

export const CHAPTERS_JSON_NAME = "chapters.json";
export const CHAPTERS_VERSION = 1;
const MAX_CHAPTERS = 400;
/** Display titles are capped here; a longer line is prose, not a title. */
export const MAX_CHAPTER_TITLE_CHARS = 120;

export type ChapterSource =
  | "epub-spine"
  | "pdf-outline"
  | "docx-heading"
  | "heading-lines"
  | "printed-toc"
  | "none";

export interface BookChapter {
  index: number;
  title: string;
  level: number;
  charStart: number;
  charEnd: number;
  /** Printed title and era, when the contents page has them. */
  subtitle?: string;
  /** The source line this chapter was aligned to, when it differs from the display title. */
  match?: string;
  /** Topics under a part, or chapters under a part, when the source has levels. */
  children?: BookChapter[];
}

export interface ChaptersDocument {
  version: 1;
  source: ChapterSource;
  chapters: BookChapter[];
}

export interface ChapterTitleHint {
  title: string;
  level: number;
  /**
   * Paragraph texts this title may align to, in preference order. Defaults
   * to `title`. An EPUB NCX label aligns to the first paragraph of the
   * spine document it points at, so the display name survives even when the
   * body prints the heading differently.
   */
  anchors?: string[];
  /** Char offset of a resolved PDF outline destination. */
  charStart?: number;
  /** PDF page index of a resolved outline destination. */
  pageIndex?: number;
}

export interface ChapterHint {
  source: ChapterSource;
  titles: ChapterTitleHint[];
  /** Char offset where each PDF page begins in `spoken`. */
  pageStarts?: number[];
  /** Contents lines kept apart by the extractor. */
  tocLines?: string[];
  /** First words of each PDF page, used to re-find page offsets after cleanup. */
  pageProbes?: string[];
}

export function emptyChapters(): ChaptersDocument {
  return { version: CHAPTERS_VERSION, source: "none", chapters: [] };
}

export function chaptersObjectKey(uploadId: string): string {
  return `pdfs/${uploadId}/${CHAPTERS_JSON_NAME}`;
}

function normTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Alignment key: case- and trailing-punctuation-insensitive. */
function normAnchor(value: string): string {
  return normTitle(value).replace(/[.!?…\s]+$/u, "");
}

/**
 * Exact, or a prefix when a neighbour line was glued on — but only at a
 * boundary. "chapter ii" must not match "chapter iii", and "chapter i"
 * must not protect "chapter in the spring".
 */
export function headingLineMatches(block: string, wanted: string): boolean {
  const a = normAnchor(block);
  const b = normAnchor(wanted);
  if (!a || !b) return false;
  if (a === b) return true;
  if (headingPrefix(a, b) || headingPrefix(b, a)) return true;
  return headingContained(a, b) || headingContained(b, a);
}

/** "democracy. part three …" contains the heading. "chapter i" does not contain "chapter in". */
function headingContained(block: string, wanted: string): boolean {
  if (wanted.length < 6 || block.length <= wanted.length) return false;
  let from = 0;
  while (from <= block.length - wanted.length) {
    const idx = block.indexOf(wanted, from);
    if (idx < 0) return false;
    const before = block.slice(0, idx);
    const after = block[idx + wanted.length] ?? "";
    const atBoundary = idx === 0 || /[.!?]\s*$/.test(before);
    const afterOk = !after || !/^[\p{L}\p{N}]/u.test(after);
    if (atBoundary && afterOk) return true;
    from = idx + 1;
  }
  return false;
}

function headingPrefix(longer: string, shorter: string): boolean {
  if (shorter.length < 6 || longer.length <= shorter.length) return false;
  if (!longer.startsWith(shorter)) return false;
  return !/^[\p{L}\p{N}]/u.test(longer.slice(shorter.length));
}

/** This many consecutive outline hits is a contents table, not the body. */
export const CONTENTS_HEADING_RUN = 3;

/** Display title: Title Case for ALL-CAPS lines (Roman numerals kept), capped. */
export function chapterDisplayTitle(raw: string): string {
  let title = raw.replace(/\s+/g, " ").trim();
  if (isAllCapsTitleLine(title)) title = toTitleCase(title);
  if (title.length > MAX_CHAPTER_TITLE_CHARS) {
    title = `${title.slice(0, MAX_CHAPTER_TITLE_CHARS - 1).replace(/\s+\S*$/, "")}…`;
  }
  return title;
}

/**
 * Repeated bare labels ("CHAPTER I" under fifteen Books) read as one long
 * duplicate list. Prefix a repeat with its enclosing Book / Part title, but
 * only when the same label appears under different books — two "Epilogue"
 * entries in one book gain nothing from a shared prefix.
 */
export function withPartContextTitles(titles: string[]): string[] {
  const contextAt: (string | null)[] = [];
  let context: string | null = null;
  for (const title of titles) {
    if (isBookOrVolumeLine(title) || /^part\b/i.test(title)) {
      context = title.split(/[:.–—]/)[0]!.trim() || title;
    }
    contextAt.push(context);
  }
  const contextsByKey = new Map<string, Set<string | null>>();
  titles.forEach((title, i) => {
    const key = normTitle(title);
    const set = contextsByKey.get(key) ?? new Set<string | null>();
    set.add(contextAt[i]!);
    contextsByKey.set(key, set);
  });
  return titles.map((title, i) => {
    const here = contextAt[i];
    if (!here) return title;
    const contexts = contextsByKey.get(normTitle(title));
    if (!contexts || contexts.size < 2) return title;
    return `${here} · ${title}`;
  });
}

function withPartContext(chapters: BookChapter[]): BookChapter[] {
  const titles = withPartContextTitles(chapters.map((chapter) => chapter.title));
  return chapters.map((chapter, i) =>
    titles[i] === chapter.title ? chapter : { ...chapter, title: titles[i]! }
  );
}

function headingLevel(title: string): number {
  if (/^\d+\.\d+\b/.test(title.trim())) return 2;
  return 1;
}

const CHAPTER_FUNCTION_WORD =
  /^(?:a|an|the|of|and|or|but|to|in|on|for|with|from|by|at|as|into|over|under)$/i;

const REAL_BODY_HEADING =
  /^(?:preface|introduction|foreword|prologue|epilogue|afterword|coda|postscript|appendix|glossary|bibliography|acknowledgements?|dedication|notes?|chapter|part|book|volume|section)\b/i;

function chapterWordCount(title: string): number {
  return title
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

/** A title that stops mid-phrase: "Of The", "5 The", "Too Bad!''". */
export function isMidPhraseChapterTitle(title: string): boolean {
  const t = title.replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (/[!?]['"“”‘’]+\s*$/.test(t)) return true;
  const doubles = t.match(/["“”]/g)?.length ?? 0;
  if (doubles % 2 === 1) return true;
  const words = t
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const last = words[words.length - 1] ?? "";
  if (CHAPTER_FUNCTION_WORD.test(last)) return true;
  if (/^\d{1,4}\s+\p{L}/u.test(t) && words.length <= 3 && CHAPTER_FUNCTION_WORD.test(last)) {
    return true;
  }
  return false;
}

/**
 * ISBN, edition, copyright, Library of Congress, and publisher lines are
 * not chapters. A real sentence that merely mentions them is left alone
 * when it is long enough to be prose.
 */
export function isDiscardedChapterTitle(title: string): boolean {
  const t = title.replace(/\s+/g, " ").trim();
  if (!t) return true;
  if (isContentsEntryLine(t)) return true;
  if (isMidPhraseChapterTitle(t)) return true;
  if (t.length > 200) return false;
  if (/^ISBN\b/i.test(t)) return true;
  if (/\bISBN(?:-1[03])?\b/i.test(t) && /\d(?:[-\s]?\d){8,}/.test(t) && t.length <= 100) {
    return true;
  }
  if (/\bcatalogu?ing[- ]in[- ]publication\b/i.test(t)) return true;
  if (/\blibrary of congress\b/i.test(t) && t.length <= 180 && !/[.!?]/.test(t.slice(0, -1))) {
    return true;
  }
  if (/^(?:copyright|©)\b/i.test(t) && t.length <= 160) return true;
  if (/\ball rights reserved\b/i.test(t) && t.length < 120) return true;
  if (
    t.length <= 80 &&
    /^(?:(?:the|a)\s+)?(?:first|second|third|fourth|new|revised|\d+(?:st|nd|rd|th))\b/i.test(t) &&
    /\bedition\b/i.test(t)
  ) {
    return true;
  }
  if (/^(?:published by|printed in|printing history)\b/i.test(t) && t.length <= 120) return true;
  if (/^[IVXLCDM]{2,}\.$/.test(t)) return true;
  if (/^\d{1,2}\.\d\s+\p{L}/u.test(t) && !isAcademicNumberedHeading(t)) return true;
  const shortNumber = /^(\d)\s+(\p{L}+)$/u.exec(t);
  if (shortNumber && !isAcademicNumberedHeading(t) && (shortNumber[2]?.length ?? 0) <= 5) {
    return true;
  }
  return false;
}

function isStructuralChapterTitle(title: string): boolean {
  return REAL_BODY_HEADING.test(title.trim()) || isBookOrVolumeLine(title);
}

function chapterFollowing(spoken: string, chapter: BookChapter, next?: BookChapter): string {
  const from = Math.max(0, Math.min(spoken.length, chapter.charStart));
  const end = next ? Math.max(from, Math.min(spoken.length, next.charStart)) : spoken.length;
  const slice = spoken.slice(from, end);
  const gap = slice.search(/\n\s*\n/);
  if (gap < 0) return "";
  return slice.slice(gap).replace(/\s+/g, " ").trim();
}

function hasNarrationContent(following: string): boolean {
  return following.length >= 40 && /[a-z]{3,}/.test(following);
}

function isRealBodyHeading(title: string, following: string): boolean {
  if (isDiscardedChapterTitle(title)) return false;
  // Part / Book / Chapter / Preface count even when the next line is the
  // chapter under them. A one- or two-word scrap needs prose under it.
  if (isStructuralChapterTitle(title)) return true;
  const words = chapterWordCount(title);
  if (words <= 1) return false;
  if (words >= 3) return true;
  if (words === 2 && hasNarrationContent(following)) return true;
  return false;
}

/** A one-word scrap, or a two-word scrap with nothing under it. */
function isStrayFragment(title: string, following: string): boolean {
  if (isStructuralChapterTitle(title)) return false;
  if (isDiscardedChapterTitle(title)) return true;
  const words = chapterWordCount(title);
  if (words <= 1) return true;
  if (words >= 3) return false;
  return !hasNarrationContent(following);
}

/**
 * Drop title-page scraps and catalog lines. Everything before the first
 * real body heading (Preface, Introduction, Chapter, Part with prose) goes.
 * A one-word chapter that actually has a body stays.
 */
export function chaptersForNarration(chapters: BookChapter[], spoken: string): BookChapter[] {
  let bodyStarted = false;
  const kept: BookChapter[] = [];
  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i]!;
    const title = chapter.title.trim();
    if (!title) continue;
    if (
      isDiscardedChapterTitle(title) ||
      isContentsEntryLine(chapter.match ?? "") ||
      isContentsEntryLine(title)
    ) {
      continue;
    }
    const following = chapterFollowing(spoken, chapter, chapters[i + 1]);
    if (!bodyStarted) {
      if (!isRealBodyHeading(title, following)) continue;
      bodyStarted = true;
    } else if (isStrayFragment(title, following)) {
      continue;
    }
    kept.push(chapter);
  }
  return finishBounds(kept, spoken.length);
}

/**
 * Clear heading flags that are title-page scraps, catalog lines, or contents
 * rows. Display titles win over the source line, so an outline entry "1"
 * titled "Chapter 1: The Escalation" stays.
 */
export function narrationHeadingFlags(
  blocks: string[],
  flags: boolean[],
  titles?: (string | undefined)[]
): boolean[] {
  const spokenParts: string[] = [];
  const starts: number[] = [];
  let cursor = 0;
  for (const block of blocks) {
    starts.push(cursor);
    spokenParts.push(block);
    cursor += block.length + 2;
  }
  const spoken = spokenParts.join("\n\n");
  const chapters: BookChapter[] = [];
  const indexes: number[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (!flags[i]) continue;
    indexes.push(i);
    chapters.push({
      index: chapters.length,
      title: (titles?.[i] || blocks[i] || "").trim(),
      level: 1,
      charStart: starts[i]!,
      charEnd: spoken.length,
      match: blocks[i],
    });
  }
  const kept = new Set(chaptersForNarration(chapters, spoken).map((chapter) => chapter.charStart));
  const next = flags.slice();
  for (const index of indexes) {
    if (!kept.has(starts[index]!)) next[index] = false;
  }
  return next;
}

function finishBounds(chapters: BookChapter[], textLength: number): BookChapter[] {
  const capped = chapters.slice(0, MAX_CHAPTERS);
  for (let i = 0; i < capped.length; i++) {
    const next = capped[i + 1];
    capped[i] = {
      ...capped[i]!,
      index: i,
      charEnd: next ? next.charStart : textLength,
    };
  }
  return capped;
}

const RUNNING_HEAD_GAP = 1500;

/**
 * A later copy is a running head only when it sits about a page from the
 * previous copy and almost no text is between them. A restart with a real
 * body stays.
 */
function dropRepeated(chapters: BookChapter[], textLength: number): BookChapter[] {
  const last = new Map<string, BookChapter>();
  const kept: BookChapter[] = [];
  for (const chapter of chapters) {
    const key = normTitle(chapter.title);
    const prev = last.get(key);
    const gap = prev ? chapter.charStart - prev.charStart : RUNNING_HEAD_GAP;
    const between = prev ? gap - prev.title.length : RUNNING_HEAD_GAP;
    if (prev && gap <= RUNNING_HEAD_GAP && between <= 200 && between < 80) {
      continue;
    }
    kept.push(chapter);
    last.set(key, chapter);
  }
  return finishBounds(kept, textLength);
}

function paragraphSpans(spoken: string): { text: string; start: number }[] {
  const text = spoken.replace(/\r\n/g, "\n");
  const spans: { text: string; start: number }[] = [];
  const re = /\n\s*\n/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    spans.push({ text: text.slice(start, match.index), start });
    start = match.index + match[0].length;
  }
  spans.push({ text: text.slice(start), start });
  return spans;
}

/**
 * How many outline entries may be skipped when one is missing from the
 * text (a dropped front-matter title must not lose every later chapter).
 */
const ALIGN_LOOKAHEAD = 12;

export function alignTitles(
  spoken: string,
  titles: ChapterTitleHint[],
  source: Exclude<ChapterSource, "none" | "heading-lines" | "printed-toc">
): ChaptersDocument {
  const wanted = titles
    .map((title) => ({
      ...title,
      keys: (title.anchors?.length ? title.anchors : [title.title])
        .map(normAnchor)
        .filter((key) => key.length > 0 && key.length <= 160),
    }))
    .filter((title) => title.keys.length > 0);
  if (!spoken.trim() || wanted.length === 0) return emptyChapters();

  const chapters: BookChapter[] = [];
  let titleIdx = 0;
  const spans = paragraphSpans(spoken);
  const matchesOutline = (para: string) => {
    const key = normAnchor(para);
    if (!key || key.length > 160) return false;
    return wanted.some((title) => title.keys.includes(key));
  };
  for (let i = 0; i < spans.length && titleIdx < wanted.length; i++) {
    const para = spans[i]!.text.replace(/\s+/g, " ").trim();
    if (!para || isContentsEntryLine(para)) continue;
    // A contents row is an outline label followed by another. The body
    // heading is the one followed by prose, so it stays even when the
    // contents page ends on the line above it.
    let run = 0;
    while (i + run + 1 < spans.length) {
      const here = spans[i + run]!.text.replace(/\s+/g, " ").trim();
      const after = spans[i + run + 1]!.text.replace(/\s+/g, " ").trim();
      if (!here || !after || !matchesOutline(here) || !matchesOutline(after)) break;
      run += 1;
    }
    if (run >= CONTENTS_HEADING_RUN) {
      i += run - 1;
      continue;
    }
    const key = normAnchor(para);
    const span = spans[i]!;
    let hit = -1;
    const stop = Math.min(titleIdx + ALIGN_LOOKAHEAD, wanted.length);
    for (let j = titleIdx; j < stop; j++) {
      const byDest =
        typeof wanted[j]!.charStart === "number" &&
        span.start <= wanted[j]!.charStart! &&
        (spans[i + 1] == null || wanted[j]!.charStart! < spans[i + 1]!.start);
      if (
        byDest ||
        (key &&
          key.length <= 400 &&
          wanted[j]!.keys.some((wantedKey) => headingLineMatches(para, wantedKey)))
      ) {
        hit = j;
        break;
      }
    }
    if (hit < 0) continue;
    const hint = wanted[hit]!;
    const placedByDest = typeof hint.charStart === "number";
    if (!placedByDest && laterSameHeading(spans, i, hint.keys) && !isBodyHeadingBlock(
      spans.map((item) => item.text),
      i
    )) {
      continue;
    }
    chapters.push({
      index: chapters.length,
      title: chapterDisplayTitle(hint.title),
      level: hint.level > 0 ? hint.level : 1,
      charStart: span.start,
      charEnd: spoken.length,
      match: para,
    });
    titleIdx = hit + 1;
  }
  const narrated = withPartContext(
    chaptersForNarration(dropRepeated(chapters, spoken.length), spoken)
  );
  const bounded = nestOutline(narrated, spoken.length);
  if (bounded.length === 0) return emptyChapters();
  return { version: CHAPTERS_VERSION, source, chapters: bounded };
}

function laterSameHeading(
  spans: { text: string; start: number }[],
  index: number,
  keys: string[]
): boolean {
  for (let i = index + 1; i < spans.length; i++) {
    const para = spans[i]!.text.replace(/\s+/g, " ").trim();
    if (para && keys.some((key) => headingLineMatches(para, key))) return true;
  }
  return false;
}

function nestByLevel(chapters: BookChapter[]): BookChapter[] {
  if (!chapters.some((chapter) => chapter.level > 1)) return chapters;
  const roots: BookChapter[] = [];
  const stack: BookChapter[] = [];
  for (const chapter of chapters) {
    const node: BookChapter = { ...chapter };
    delete node.children;
    while (stack.length > 0 && stack[stack.length - 1]!.level >= node.level) stack.pop();
    const parent = stack[stack.length - 1];
    if (!parent) roots.push(node);
    else {
      parent.children = parent.children ?? [];
      parent.children.push(node);
    }
    stack.push(node);
  }
  return roots;
}

function finishTree(nodes: BookChapter[], end: number): BookChapter[] {
  const capped = nodes.slice(0, MAX_CHAPTERS);
  for (let i = 0; i < capped.length; i++) {
    const nextStart = capped[i + 1]?.charStart ?? end;
    const children = capped[i]!.children?.length
      ? finishTree(capped[i]!.children!, nextStart)
      : undefined;
    capped[i] = {
      ...capped[i]!,
      index: i,
      charEnd: nextStart,
      ...(children && children.length > 0 ? { children } : {}),
    };
    if (!children?.length) delete capped[i]!.children;
  }
  return capped;
}

/** Nest only when the outline itself has levels. Heading-line lists stay flat. */
function nestOutline(chapters: BookChapter[], textLength: number): BookChapter[] {
  return finishTree(nestByLevel(chapters), textLength);
}

export function chaptersFromHeadingLines(spoken: string): ChaptersDocument {
  const text = spoken.replace(/\r\n/g, "\n");
  if (!text.trim()) return emptyChapters();
  const spans = paragraphSpans(text).map((span) => ({
    ...span,
    para: span.text.replace(/\s+/g, " ").trim(),
  }));
  const flags = playbackHeadingFlags(spans.map((span) => span.para));
  const chapters: BookChapter[] = [];
  for (let i = 0; i < spans.length; i++) {
    const para = spans[i]!.para;
    if (!para || para.length > MAX_CHAPTER_TITLE_CHARS || !flags[i]) continue;
    chapters.push({
      index: chapters.length,
      title: chapterDisplayTitle(para),
      level: headingLevel(para),
      charStart: spans[i]!.start,
      charEnd: text.length,
      match: para,
    });
  }
  const bounded = withPartContext(
    chaptersForNarration(dropRepeated(chapters, text.length), text)
  );
  if (bounded.length === 0) return emptyChapters();
  return {
    version: CHAPTERS_VERSION,
    source: "heading-lines",
    chapters: bounded,
  };
}

/**
 * A single "chapter" that covers nearly the whole book is a title page,
 * not an outline. The numbered Section list serves that book better.
 */
function countChapterNodes(chapters: BookChapter[]): number {
  return chapters.reduce(
    (sum, chapter) => sum + 1 + countChapterNodes(chapter.children ?? []),
    0
  );
}

function dropIfOneGiantTitle(doc: ChaptersDocument): ChaptersDocument {
  if (doc.chapters.length !== 1) return doc;
  const only = doc.chapters[0]!;
  if (only.children && only.children.length > 0) return doc;
  if (only.charEnd > 0 && only.charStart <= only.charEnd * 0.1) {
    return emptyChapters();
  }
  return doc;
}

export function resolveChapters(
  spoken: string,
  hint: ChapterHint
): ChaptersDocument {
  let aligned = emptyChapters();
  if (
    (hint.source === "epub-spine" ||
      hint.source === "pdf-outline" ||
      hint.source === "docx-heading") &&
    hint.titles.length > 0
  ) {
    const titles = hint.titles.map((title) => {
      if (typeof title.charStart === "number" || title.pageIndex == null || !hint.pageStarts) {
        return title;
      }
      const charStart = hint.pageStarts[title.pageIndex];
      return typeof charStart === "number" ? { ...title, charStart } : title;
    });
    aligned = dropIfOneGiantTitle(alignTitles(spoken, titles, hint.source));
    const alignedCount = countChapterNodes(aligned.chapters);
    if (alignedCount > 0 && alignedCount * 2 >= hint.titles.length) {
      return aligned;
    }
  }
  const printed = chaptersFromPrintedToc(spoken, hint);
  if (printed && printed.chapters.length > 0) return printed;
  const fromLines = dropIfOneGiantTitle(chaptersFromHeadingLines(spoken));
  if (countChapterNodes(aligned.chapters) > fromLines.chapters.length) return aligned;
  return fromLines.chapters.length > 0 ? fromLines : emptyChapters();
}

/**
 * Ordered (match line, display title) pairs. Generation forces a section
 * break where the speakable text has a paragraph equal to `match` and shows
 * `title` in the player. `match` is the pre-decoration source line, so
 * "Book Two · Chapter I" still finds the line "CHAPTER I".
 */
function pushMatches(
  chapters: BookChapter[],
  includeChildren: boolean,
  out: { match: string; title: string }[]
): void {
  for (const chapter of chapters) {
    out.push({
      match: chapter.match ?? chapter.title,
      title: chapter.title,
    });
    if (includeChildren && chapter.children?.length) {
      pushMatches(chapter.children, true, out);
    }
  }
}

export function chapterMatchList(
  doc: ChaptersDocument
): { match: string; title: string }[] {
  const out: { match: string; title: string }[] = [];
  // Printed topics are display positions. They must not slice the audiobook.
  pushMatches(doc.chapters, doc.source !== "printed-toc", out);
  return out;
}

/**
 * Put a protected heading back on its own paragraph after cleanup glued it
 * to the sentences on either side.
 */
export function restoreProtectedHeadingBreaks(text: string, headings: string[]): string {
  const unique = [...new Set(headings.map((heading) => heading.replace(/\s+/g, " ").trim()))]
    .filter((heading) => heading.length >= 6)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const heading of unique) {
    const body = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![\\p{L}\\p{N}])(${body})(?![\\p{L}\\p{N}])`, "giu");
    out = out.replace(re, "\n\n$1\n\n");
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function safeResolveChapters(
  spoken: string,
  hint: ChapterHint
): ChaptersDocument {
  try {
    return resolveChapters(spoken, hint);
  } catch {
    return emptyChapters();
  }
}

export function parseChaptersDocument(raw: string): ChaptersDocument | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ChaptersDocument>;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.chapters)) {
      return null;
    }
    const source: ChapterSource =
      parsed.source === "epub-spine" ||
      parsed.source === "pdf-outline" ||
      parsed.source === "docx-heading" ||
      parsed.source === "heading-lines" ||
      parsed.source === "printed-toc" ||
      parsed.source === "none"
        ? parsed.source
        : "none";
    let remaining = MAX_CHAPTERS;
    const readChapter = (row: unknown): BookChapter | null => {
      if (remaining <= 0) return null;
      if (!row || typeof row !== "object") return null;
      const record = row as BookChapter & { subtitle?: unknown; children?: unknown };
      const raw = typeof record.title === "string" ? record.title.trim() : "";
      if (!raw) return null;
      remaining -= 1;
      const title = raw.slice(0, MAX_CHAPTER_TITLE_CHARS + 40);
      const match =
        typeof record.match === "string" && record.match.trim() ? record.match : undefined;
      const subtitle =
        typeof record.subtitle === "string" && record.subtitle.trim()
          ? record.subtitle.trim().slice(0, 240)
          : undefined;
      const children = Array.isArray(record.children)
        ? record.children.flatMap((child) => {
            const parsedChild = readChapter(child);
            return parsedChild ? [parsedChild] : [];
          })
        : undefined;
      return {
        index: 0,
        title,
        level: typeof record.level === "number" && record.level > 1 ? record.level : 1,
        charStart: typeof record.charStart === "number" ? record.charStart : 0,
        charEnd: typeof record.charEnd === "number" ? record.charEnd : 0,
        ...(subtitle ? { subtitle } : {}),
        ...(match ? { match } : {}),
        ...(children && children.length > 0 ? { children } : {}),
      };
    };
    const chapters: BookChapter[] = [];
    for (const row of parsed.chapters) {
      const chapter = readChapter(row);
      if (!chapter) continue;
      chapter.index = chapters.length;
      chapters.push(chapter);
    }
    return {
      version: 1,
      source,
      chapters,
    };
  } catch {
    return null;
  }
}
