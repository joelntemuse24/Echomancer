/**
 * Chapter outline stored next to `content.txt`.
 *
 * Offsets are JavaScript string indexes into the speakable `content.txt`.
 * Detection failure is an empty `source: "none"` document, never a failed upload.
 */

import {
  isBookOrVolumeLine,
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
  | "none";

export interface BookChapter {
  index: number;
  title: string;
  level: number;
  charStart: number;
  charEnd: number;
  /** The source line this chapter was aligned to, when it differs from the display title. */
  match?: string;
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
}

export interface ChapterHint {
  source: ChapterSource;
  titles: ChapterTitleHint[];
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
  source: Exclude<ChapterSource, "none" | "heading-lines">
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
  for (const span of paragraphSpans(spoken)) {
    if (titleIdx >= wanted.length) break;
    const para = span.text.replace(/\s+/g, " ").trim();
    if (!para) continue;
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
    const hint = wanted[hit]!;
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
  const bounded = withPartContext(dropRepeated(chapters, spoken.length));
  if (bounded.length === 0) return emptyChapters();
  return { version: CHAPTERS_VERSION, source, chapters: bounded };
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
  const bounded = withPartContext(dropRepeated(chapters, text.length));
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
function dropIfOneGiantTitle(doc: ChaptersDocument): ChaptersDocument {
  if (doc.chapters.length !== 1) return doc;
  const only = doc.chapters[0]!;
  if (only.charEnd > 0 && only.charStart <= only.charEnd * 0.1) {
    return emptyChapters();
  }
  return doc;
}

export function resolveChapters(
  spoken: string,
  hint: ChapterHint
): ChaptersDocument {
  if (
    (hint.source === "epub-spine" ||
      hint.source === "pdf-outline" ||
      hint.source === "docx-heading") &&
    hint.titles.length > 0
  ) {
    const aligned = dropIfOneGiantTitle(alignTitles(spoken, hint.titles, hint.source));
    if (aligned.chapters.length > 0) {
      // An outline that matches under half its entries is usually a stale or
      // abridged TOC; trust the body's own heading lines when there are more.
      if (aligned.chapters.length * 2 >= hint.titles.length) {
        return aligned;
      }
      const fromLines = dropIfOneGiantTitle(chaptersFromHeadingLines(spoken));
      return fromLines.chapters.length > aligned.chapters.length ? fromLines : aligned;
    }
  }
  const fromLines = dropIfOneGiantTitle(chaptersFromHeadingLines(spoken));
  return fromLines.chapters.length > 0 ? fromLines : emptyChapters();
}

/**
 * Ordered (match line, display title) pairs. Generation forces a section
 * break where the speakable text has a paragraph equal to `match` and shows
 * `title` in the player. `match` is the pre-decoration source line, so
 * "Book Two · Chapter I" still finds the line "CHAPTER I".
 */
export function chapterMatchList(
  doc: ChaptersDocument
): { match: string; title: string }[] {
  return doc.chapters.map((chapter) => ({
    match: chapter.match ?? chapter.title,
    title: chapter.title,
  }));
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
      parsed.source === "none"
        ? parsed.source
        : "none";
    const chapters: BookChapter[] = [];
    for (const row of parsed.chapters) {
      if (!row || typeof row !== "object") return null;
      const raw = typeof row.title === "string" ? row.title.trim() : "";
      if (!raw) continue;
      const title = raw.slice(0, MAX_CHAPTER_TITLE_CHARS + 40);
      const match =
        typeof (row as { match?: unknown }).match === "string" &&
        ((row as { match?: string }).match ?? "").trim()
          ? (row as { match: string }).match
          : undefined;
      chapters.push({
        index: chapters.length,
        title,
        level: typeof row.level === "number" && row.level > 1 ? row.level : 1,
        charStart: typeof row.charStart === "number" ? row.charStart : 0,
        charEnd: typeof row.charEnd === "number" ? row.charEnd : 0,
        ...(match ? { match } : {}),
      });
    }
    return {
      version: 1,
      source,
      chapters: chapters.slice(0, MAX_CHAPTERS),
    };
  } catch {
    return null;
  }
}
