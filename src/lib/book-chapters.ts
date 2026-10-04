/**
 * Chapter outline stored next to `content.txt`.
 *
 * Offsets are JavaScript string indexes into the speakable `content.txt`.
 * Detection failure is an empty `source: "none"` document, never a failed upload.
 */

import { chaptersFromPrintedToc, looksLikeNarration } from "@/lib/printed-toc";
import {
  isAcademicNumberedHeading,
  isAppendixHeadingLine,
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
    if (
      isBookOrVolumeLine(title) ||
      /^part\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i.test(
        title
      )
    ) {
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
  // "5 White" is a line-break scrap. "3 BERT" is a section title: the word
  // is an all-caps acronym on its own line. Title case happens later, so
  // this check has to see the source line.
  const shortNumber = /^(\d)\s+(\p{L}+)$/u.exec(t);
  if (shortNumber && !isAcademicNumberedHeading(t)) {
    const word = shortNumber[2] ?? "";
    const acronym =
      word.length >= 2 &&
      word.length <= 5 &&
      word === word.toUpperCase() &&
      /\p{Lu}/u.test(word);
    if (!acronym) return true;
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
  if (words >= 3) return true;
  if (words === 2 && hasNarrationContent(following)) return true;
  if (words <= 1 && following.length >= 400) return true;
  return false;
}

/** A one-word scrap, or a two-word scrap with nothing under it. */
function isStrayFragment(title: string, following: string): boolean {
  if (isStructuralChapterTitle(title)) return false;
  if (isDiscardedChapterTitle(title)) return true;
  const words = chapterWordCount(title);
  if (words >= 3) return false;
  if (words === 2) return !hasNarrationContent(following);
  return following.length < 400;
}

/**
 * Shape checks need the source line. "3 BERT" title-cases to "3 Bert", and
 * that display string looks like the scrap "5 White".
 */
function sourceHeading(chapter: BookChapter): string {
  const title = chapter.title.replace(/\s+/g, " ").trim();
  const match = (chapter.match || "").replace(/\s+/g, " ").trim();
  if (!match || match.length > 120) return title;
  if (normTitle(chapterDisplayTitle(match)) === normTitle(title)) return match;
  return title;
}

/**
 * Drop title-page scraps and catalog lines. Everything before the first
 * real body heading (Preface, Introduction, Chapter, Part with prose) goes.
 * A one-word chapter that actually has a body stays.
 */
export function chaptersForNarration(
  chapters: BookChapter[],
  spoken: string,
  opts?: { trusted?: boolean }
): BookChapter[] {
  let bodyStarted = false;
  const kept: BookChapter[] = [];
  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i]!;
    const title = chapter.title.trim();
    if (!title) continue;
    const raw = sourceHeading(chapter);
    if (isContentsEntryLine(chapter.match ?? "") || isContentsEntryLine(title) || isContentsEntryLine(raw)) {
      continue;
    }
    // Styled headings (DOCX, EPUB nav, a validated outline) already passed
    // a source that names them. Shape filters must not drop "2.1 Subscriptions".
    if (opts?.trusted) {
      kept.push(chapter);
      continue;
    }
    if (isDiscardedChapterTitle(raw)) continue;
    const following = chapterFollowing(spoken, chapter, chapters[i + 1]);
    if (!bodyStarted) {
      if (!isRealBodyHeading(raw, following)) continue;
      bodyStarted = true;
    } else if (isStrayFragment(raw, following)) {
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

function paragraphText(span: { text: string }): string {
  return span.text.replace(/\s+/g, " ").trim();
}

/** Char offset where the contents page ends, or 0 when there is no banner. */
function contentsRegionEnd(spans: { text: string; start: number }[]): number {
  const limit = Math.min(spans.length, 80);
  let banner = -1;
  for (let i = 0; i < limit; i++) {
    if (/^contents$/i.test(paragraphText(spans[i]!))) {
      banner = i;
      break;
    }
  }
  if (banner < 0) return 0;
  for (let i = banner + 1; i < spans.length; i++) {
    if (!looksLikeNarration(spans[i]!.text)) continue;
    // A repeated label just before the prose is the body chapter. The first
    // time that label appears is still the contents row.
    const prevIndex = i - 1;
    const prev = paragraphText(spans[prevIndex] ?? { text: "" });
    if (prevIndex > banner && prev && prev.length <= 120) {
      const key = normAnchor(prev);
      for (let j = banner + 1; j < prevIndex; j++) {
        const earlier = paragraphText(spans[j]!);
        if (earlier && normAnchor(earlier) === key) return spans[prevIndex]!.start;
      }
    }
    return spans[i]!.start;
  }
  return 0;
}

/**
 * Running heads sit about a page apart. Chapter restarts are farther apart
 * and the gaps are not uniform, so they do not count.
 */
function isPageCadence(starts: number[]): boolean {
  if (starts.length < 5) return false;
  const gaps: number[] = [];
  for (let i = 1; i < starts.length; i++) gaps.push(starts[i]! - starts[i - 1]!);
  gaps.sort((a, b) => a - b);
  const min = gaps[0]!;
  const max = gaps[gaps.length - 1]!;
  const median = gaps[Math.floor(gaps.length / 2)]!;
  if (median < 800 || median > 9000) return false;
  if (min <= 0 || max > min * 3) return false;
  return true;
}

/**
 * Skip a copy that sits inside the contents span when a later copy exists,
 * or a later copy in a page-cadence run. The first body copy stays.
 */
export function skipCadenceOrContentsCopy(
  blocks: string[],
  index: number,
  matches: (block: string) => boolean
): boolean {
  const starts: number[] = [];
  let cursor = 0;
  for (const block of blocks) {
    starts.push(cursor);
    cursor += block.length + 2;
  }
  const hits: number[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (matches(blocks[i] ?? "")) hits.push(i);
  }
  const pos = hits.indexOf(index);
  if (pos < 0) return false;
  const end = contentsRegionEnd(blocks.map((text, i) => ({ text, start: starts[i]! })));
  if (starts[index]! < end && pos < hits.length - 1) return true;
  if (pos === 0) return false;
  return isPageCadence(hits.map((hit) => starts[hit]!));
}

function paragraphMatchesTitle(para: string, keys: string[]): boolean {
  if (!para || para.length > 200) return false;
  const key = normAnchor(para);
  if (key && key.length <= 160 && keys.includes(key)) return true;
  return keys.some((wanted) => headingLineMatches(para, wanted));
}

function nextPageStart(pageStarts: number[], charStart: number, textLength: number): number {
  let end = textLength;
  for (const start of pageStarts) {
    if (start > charStart + 1 && start < end) end = start;
  }
  return end;
}

/**
 * A collapsed page probe can put the next start a few dozen characters
 * later, which hides the heading. A real page is much longer, so a tiny
 * gap extends to the next start that actually moves.
 */
function destinationPageEnd(pageStarts: number[], charStart: number, textLength: number): number {
  const next = nextPageStart(pageStarts, charStart, textLength);
  if (next - charStart >= 80) return next;
  for (const start of pageStarts) {
    if (start >= charStart + 400) return start;
  }
  return Math.min(textLength, charStart + 8000);
}

function spanIndexAt(spans: { start: number }[], offset: number): number {
  for (let i = 0; i < spans.length; i++) {
    const start = spans[i]!.start;
    const end = spans[i + 1]?.start ?? Number.POSITIVE_INFINITY;
    if (offset >= start && offset < end) return i;
  }
  return Math.max(0, spans.length - 1);
}

/** Lowercase, one space, straight quotes. Offsets point at the original chars. */
function foldPage(slice: string, base: number): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < slice.length; i++) {
    let ch = slice[i]!;
    if (/\s/u.test(ch)) {
      if (folded.length > 0) pendingSpace = true;
      continue;
    }
    if (ch === "\u2018" || ch === "\u2019" || ch === "\u201a") ch = "'";
    else if (ch === "\u201c" || ch === "\u201d" || ch === "\u201e") ch = '"';
    else if (ch === "\u2013" || ch === "\u2014") ch = "-";
    if (pendingSpace) {
      folded += " ";
      map.push(base + i);
      pendingSpace = false;
    }
    folded += ch.toLowerCase();
    map.push(base + i);
  }
  return { folded, map };
}

function inlineNeedle(title: string): string {
  return title
    .replace(/[\u2018\u2019\u201a]/g, "'")
    .replace(/[\u201c\u201d\u201e]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[.!?…:]+$/u, "");
}

/**
 * The heading may continue after a citation ("…aRWC+19 3.1 Language…")
 * instead of starting the line. A letter glued on either side is a
 * different word. A digit or mark before it is the citation.
 */
function findInlineOffsets(spoken: string, start: number, end: number, title: string): number[] {
  const needle = inlineNeedle(title);
  if (needle.length < 8) return [];
  const { folded, map } = foldPage(spoken.slice(start, end), start);
  const found: number[] = [];
  let from = 0;
  while (from <= folded.length - needle.length) {
    const at = folded.indexOf(needle, from);
    if (at < 0) break;
    const before = at > 0 ? (folded[at - 1] ?? "") : "";
    const after = folded[at + needle.length] ?? "";
    const beforeOk = !before || !/\p{L}/u.test(before);
    const afterOk = !after || !/[\p{L}\p{N}]/u.test(after);
    if (beforeOk && afterOk) {
      const pos = map[at];
      if (pos != null) found.push(pos);
    }
    from = at + 1;
  }
  return found;
}

/**
 * Every place the title sits on the destination page: its own paragraph,
 * or the same words after a citation. The contents page does not count.
 */
function pageCandidates(
  spoken: string,
  spans: { text: string; start: number }[],
  charStart: number,
  pageEnd: number,
  keys: string[],
  title: string,
  contentsEnd: number
): { span: number; charStart: number }[] {
  if (contentsEnd > 0 && charStart <= contentsEnd) return [];
  if (pageEnd <= charStart) return [];
  const found: { span: number; charStart: number }[] = [];
  for (let i = 0; i < spans.length; i++) {
    const start = spans[i]!.start;
    const end = spans[i + 1]?.start ?? Number.POSITIVE_INFINITY;
    if (end <= charStart) continue;
    if (start >= pageEnd) break;
    if (start < contentsEnd) continue;
    if (!paragraphMatchesTitle(paragraphText(spans[i]!), keys)) continue;
    found.push({ span: i, charStart: start });
  }
  const needles = new Set<string>();
  const display = inlineNeedle(title);
  if (display.length >= 8) needles.add(display);
  for (const key of keys) {
    const needle = inlineNeedle(key);
    if (needle.length >= 8) needles.add(needle);
  }
  for (const needle of needles) {
    for (const at of findInlineOffsets(spoken, charStart, pageEnd, needle)) {
      found.push({ span: spanIndexAt(spans, at), charStart: at });
    }
  }
  found.sort((a, b) => a.charStart - b.charStart || a.span - b.span);
  return found;
}

/** Paragraph near a destination whose text is the title. A contents hit is rejected. */
function destSpanIndex(
  spans: { text: string; start: number }[],
  charStart: number,
  keys: string[],
  contentsEnd: number
): number | null {
  if (contentsEnd > 0 && charStart <= contentsEnd) return null;
  let nearest = -1;
  let nearestDist = Infinity;
  for (let i = 0; i < spans.length; i++) {
    const start = spans[i]!.start;
    const end = spans[i + 1]?.start ?? Number.POSITIVE_INFINITY;
    if (end < charStart - 200) continue;
    if (start > charStart + 1200) break;
    if (start < contentsEnd) continue;
    if (!paragraphMatchesTitle(paragraphText(spans[i]!), keys)) continue;
    if (start <= charStart && charStart < end) return i;
    const dist = Math.abs(start - charStart);
    if (dist < nearestDist) {
      nearest = i;
      nearestDist = dist;
    }
  }
  return nearest >= 0 && nearestDist <= 1200 ? nearest : null;
}

export function alignTitles(
  spoken: string,
  titles: ChapterTitleHint[],
  source: Exclude<ChapterSource, "none" | "heading-lines" | "printed-toc">,
  pageStarts?: number[]
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
  const contentsEnd = contentsRegionEnd(spans);
  const blocks = spans.map((span) => paragraphText(span));
  const validatedDest = new Map<number, number>();
  const inlineStart = new Map<number, number>();
  let cursor = 0;
  for (let j = 0; j < wanted.length; j++) {
    const dest = wanted[j]!.charStart;
    if (typeof dest !== "number") continue;
    if (pageStarts && pageStarts.length > 0) {
      const pageEnd = destinationPageEnd(pageStarts, dest, spoken.length);
      const found = pageCandidates(
        spoken,
        spans,
        dest,
        pageEnd,
        wanted[j]!.keys,
        wanted[j]!.title,
        contentsEnd
      ).find((candidate) => candidate.charStart >= cursor);
      if (!found) continue;
      validatedDest.set(j, found.span);
      if (found.charStart !== spans[found.span]!.start) inlineStart.set(j, found.charStart);
      cursor = found.charStart + 1;
      continue;
    }
    const at = destSpanIndex(spans, dest, wanted[j]!.keys, contentsEnd);
    if (at != null) validatedDest.set(j, at);
  }
  const matchesOutline = (para: string) => {
    const key = normAnchor(para);
    if (!key || key.length > 160) return false;
    return wanted.some((title) => title.keys.includes(key));
  };
  for (let i = 0; i < spans.length && titleIdx < wanted.length; i++) {
    const para = blocks[i]!;
    if (!para || isContentsEntryLine(para)) continue;
    // A contents row is an outline label followed by another. The body
    // heading is the one followed by prose, so it stays even when the
    // contents page ends on the line above it.
    let run = 0;
    while (i + run + 1 < spans.length) {
      const here = blocks[i + run] ?? "";
      const after = blocks[i + run + 1] ?? "";
      if (!here || !after || !matchesOutline(here) || !matchesOutline(after)) break;
      run += 1;
    }
    if (run >= CONTENTS_HEADING_RUN) {
      i += run - 1;
      continue;
    }
    const span = spans[i]!;
    let hit = -1;
    const stop = Math.min(titleIdx + ALIGN_LOOKAHEAD, wanted.length);
    for (let j = titleIdx; j < stop; j++) {
      const destSpan = validatedDest.get(j);
      if (destSpan != null) {
        if (i === destSpan) {
          hit = j;
          break;
        }
        if (i < destSpan) continue;
      }
      if (paragraphMatchesTitle(para, wanted[j]!.keys)) {
        hit = j;
        break;
      }
    }
    if (hit < 0) continue;
    const hint = wanted[hit]!;
    if (
      skipCadenceOrContentsCopy(blocks, i, (block) =>
        hint.keys.some((key) => headingLineMatches(block, key))
      )
    ) {
      continue;
    }
    chapters.push({
      index: chapters.length,
      title: chapterDisplayTitle(hint.title),
      level: hint.level > 0 ? hint.level : 1,
      charStart: inlineStart.get(hit) ?? span.start,
      charEnd: spoken.length,
      match: para,
    });
    titleIdx = hit + 1;
  }
  const narrated = withPartContext(
    chaptersForNarration(dropRepeated(chapters, spoken.length), spoken, { trusted: true })
  );
  const bounded = nestOutline(narrated, spoken.length);
  if (bounded.length === 0) return emptyChapters();
  return { version: CHAPTERS_VERSION, source, chapters: bounded };
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

const UNLISTED_MATTER = /^(?:abstract|acknowledgements?|references|bibliography)$/i;

function sectionNumber(title: string): string | null {
  const match = /^((?:[A-H]|\d{1,2})(?:\.\d{1,2})*)\b/u.exec(title.trim());
  return match?.[1] ?? null;
}

function dottedDepth(title: string): number {
  const num = sectionNumber(title);
  if (!num || !num.includes(".")) return 1;
  return num.split(".").length;
}

/** A numbered subsection or appendix heading the outline may have skipped. */
function isBodySubsection(title: string): boolean {
  const t = title.trim();
  if (isAppendixHeadingLine(t)) return true;
  return /\d\.\d/.test(t) && isAcademicNumberedHeading(t);
}

function bareSectionTitle(title: string): string {
  return normAnchor(title).replace(/^(?:[a-h]|\d+(?:\.\d+)*)\s+/, "");
}

/**
 * The outline often names "Conclusion" while the body prints "7 Conclusion".
 * Keep the numbered line when it is the same section.
 */
function preferNumberedBodyTitle(outline: BookChapter[], fromLines: BookChapter[]): void {
  for (const body of fromLines) {
    const num = sectionNumber(body.title);
    if (!num) continue;
    const bare = bareSectionTitle(body.title);
    if (bare.length < 6) continue;
    for (const chapter of outline) {
      if (sectionNumber(chapter.title)) continue;
      if (bareSectionTitle(chapter.title) !== bare) continue;
      if (Math.abs(chapter.charStart - body.charStart) > 4000) continue;
      chapter.title = body.title;
      if (body.charStart > chapter.charStart) chapter.charStart = body.charStart;
      break;
    }
  }
}

function levelUnderParent(title: string, existing: BookChapter[]): number {
  const depth = dottedDepth(title);
  const num = sectionNumber(title);
  if (!num) return depth;
  let parentLevel = 0;
  for (const chapter of existing) {
    const parent = sectionNumber(chapter.title);
    if (!parent || parent === num) continue;
    if (num.startsWith(`${parent}.`)) parentLevel = Math.max(parentLevel, chapter.level);
  }
  return parentLevel > 0 ? Math.max(depth, parentLevel + 1) : depth;
}

function flattenChapters(chapters: BookChapter[]): BookChapter[] {
  const out: BookChapter[] = [];
  const walk = (nodes: BookChapter[]) => {
    for (const node of nodes) {
      const { children, ...rest } = node;
      out.push(rest);
      if (children?.length) walk(children);
    }
  };
  walk(chapters);
  return out;
}

/**
 * An outline often starts at "1 Introduction" and omits Abstract,
 * Acknowledgements, References, and the numbered subsections printed in
 * the body. Those lines still belong in the list. Subsections nest under
 * the outline entry whose number they extend.
 */
function mergeUnlistedMatter(
  aligned: ChaptersDocument,
  fromLines: ChaptersDocument
): ChaptersDocument {
  const flat = flattenChapters(aligned.chapters);
  preferNumberedBodyTitle(flat, flattenChapters(fromLines.chapters));
  const have = new Set(flat.map((chapter) => normAnchor(chapter.title)));
  const accepted: BookChapter[] = [...flat];
  const pending = flattenChapters(fromLines.chapters)
    .filter((chapter) => {
      const key = normAnchor(chapter.title);
      if (!key || have.has(key)) return false;
      const title = chapter.title.trim();
      if (UNLISTED_MATTER.test(title)) return true;
      return aligned.source === "pdf-outline" && isBodySubsection(title);
    })
    .sort((a, b) => a.charStart - b.charStart || a.level - b.level);
  if (pending.length === 0) return aligned;
  const extra: BookChapter[] = [];
  for (const chapter of pending) {
    const key = normAnchor(chapter.title);
    if (have.has(key)) continue;
    have.add(key);
    const level = UNLISTED_MATTER.test(chapter.title.trim())
      ? 1
      : levelUnderParent(chapter.title, accepted);
    const next = { ...chapter, level };
    extra.push(next);
    accepted.push(next);
  }
  const end = Math.max(0, ...accepted.map((chapter) => chapter.charEnd));
  const chapters = [...flat, ...extra].sort(
    (a, b) => a.charStart - b.charStart || a.level - b.level
  );
  return { ...aligned, chapters: nestOutline(chapters, end) };
}

function resolveChaptersInner(spoken: string, hint: ChapterHint): ChaptersDocument {
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
    aligned = dropIfOneGiantTitle(alignTitles(spoken, titles, hint.source, hint.pageStarts));
    const alignedCount = countChapterNodes(aligned.chapters);
    if (alignedCount > 0 && alignedCount * 2 >= hint.titles.length) {
      const fromLines = dropIfOneGiantTitle(chaptersFromHeadingLines(spoken));
      return mergeUnlistedMatter(aligned, fromLines);
    }
  }
  const printed = chaptersFromPrintedToc(spoken, hint);
  const fromLines = dropIfOneGiantTitle(chaptersFromHeadingLines(spoken));
  if (printed && printed.chapters.length > 0) {
    const rich = printed.chapters.some(
      (chapter) => chapter.subtitle || (chapter.children?.length ?? 0) > 0
    );
    // A short contents list with no titles or topics must not hide body chapters.
    if (rich || printed.chapters.length >= fromLines.chapters.length) return printed;
  }
  if (countChapterNodes(aligned.chapters) > fromLines.chapters.length) return aligned;
  return fromLines.chapters.length > 0 ? fromLines : emptyChapters();
}

/**
 * Exact-key alignment from before printed contents and destination checks.
 * Used when the newer path throws, so an upload still gets a chapter list.
 */
function legacyAlignTitles(
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
  for (let i = 0; i < spans.length && titleIdx < wanted.length; i++) {
    const para = paragraphText(spans[i]!);
    if (!para || isContentsEntryLine(para)) continue;
    const key = normAnchor(para);
    if (!key || key.length > 160) continue;
    let hit = -1;
    const stop = Math.min(titleIdx + ALIGN_LOOKAHEAD, wanted.length);
    for (let j = titleIdx; j < stop; j++) {
      if (wanted[j]!.keys.includes(key)) {
        hit = j;
        break;
      }
    }
    if (hit < 0) continue;
    chapters.push({
      index: chapters.length,
      title: chapterDisplayTitle(wanted[hit]!.title),
      level: wanted[hit]!.level > 0 ? wanted[hit]!.level : 1,
      charStart: spans[i]!.start,
      charEnd: spoken.length,
      match: para,
    });
    titleIdx = hit + 1;
  }
  const bounded = withPartContext(
    chaptersForNarration(dropRepeated(chapters, spoken.length), spoken)
  );
  if (bounded.length === 0) return emptyChapters();
  return { version: CHAPTERS_VERSION, source, chapters: bounded };
}

function legacyResolveChapters(spoken: string, hint: ChapterHint): ChaptersDocument {
  if (
    (hint.source === "epub-spine" ||
      hint.source === "pdf-outline" ||
      hint.source === "docx-heading") &&
    hint.titles.length > 0
  ) {
    const aligned = dropIfOneGiantTitle(legacyAlignTitles(spoken, hint.titles, hint.source));
    if (aligned.chapters.length > 0) {
      if (aligned.chapters.length * 2 >= hint.titles.length) return aligned;
      const fromLines = dropIfOneGiantTitle(chaptersFromHeadingLines(spoken));
      return fromLines.chapters.length > aligned.chapters.length ? fromLines : aligned;
    }
  }
  const fromLines = dropIfOneGiantTitle(chaptersFromHeadingLines(spoken));
  return fromLines.chapters.length > 0 ? fromLines : emptyChapters();
}

export function resolveChapters(spoken: string, hint: ChapterHint): ChaptersDocument {
  try {
    return resolveChaptersInner(spoken, hint);
  } catch {
    return legacyResolveChapters(spoken, hint);
  }
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
    try {
      return legacyResolveChapters(spoken, hint);
    } catch {
      return emptyChapters();
    }
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
