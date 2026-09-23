/**
 * Chapter outline stored next to `content.txt`.
 *
 * Offsets are JavaScript string indexes into the speakable `content.txt`.
 * Detection failure is an empty `source: "none"` document, never a failed upload.
 */

import { isChapterHeading } from "@/lib/tts/speakable-text";

export const CHAPTERS_JSON_NAME = "chapters.json";
export const CHAPTERS_VERSION = 1;
const MAX_CHAPTERS = 400;

export type ChapterSource =
  | "epub-spine"
  | "docx-heading"
  | "heading-lines"
  | "none";

export interface BookChapter {
  index: number;
  title: string;
  level: number;
  charStart: number;
  charEnd: number;
}

export interface ChaptersDocument {
  version: 1;
  source: ChapterSource;
  chapters: BookChapter[];
}

export interface ChapterTitleHint {
  title: string;
  level: number;
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

/** Drop a title that repeats like a running header. */
function dropRepeated(chapters: BookChapter[], textLength: number): BookChapter[] {
  const counts = new Map<string, number>();
  for (const chapter of chapters) {
    const key = normTitle(chapter.title);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const kept = chapters.filter(
    (chapter) => (counts.get(normTitle(chapter.title)) || 0) <= 3
  );
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

export function alignTitles(
  spoken: string,
  titles: ChapterTitleHint[],
  source: Exclude<ChapterSource, "none" | "heading-lines">
): ChaptersDocument {
  const wanted = titles
    .map((title) => ({
      ...title,
      key: normTitle(title.title),
    }))
    .filter((title) => title.key.length > 0);
  if (!spoken.trim() || wanted.length === 0) return emptyChapters();

  const chapters: BookChapter[] = [];
  let titleIdx = 0;
  for (const span of paragraphSpans(spoken)) {
    if (titleIdx >= wanted.length) break;
    const para = span.text.replace(/\s+/g, " ").trim();
    if (!para) continue;
    if (normTitle(para) !== wanted[titleIdx]!.key) continue;
    const hint = wanted[titleIdx]!;
    chapters.push({
      index: chapters.length,
      title: para,
      level: hint.level > 0 ? hint.level : 1,
      charStart: span.start,
      charEnd: spoken.length,
    });
    titleIdx += 1;
  }
  const bounded = dropRepeated(chapters, spoken.length);
  if (bounded.length === 0) return emptyChapters();
  return { version: CHAPTERS_VERSION, source, chapters: bounded };
}

export function chaptersFromHeadingLines(spoken: string): ChaptersDocument {
  const text = spoken.replace(/\r\n/g, "\n");
  if (!text.trim()) return emptyChapters();
  const chapters: BookChapter[] = [];
  for (const span of paragraphSpans(text)) {
    const para = span.text.replace(/\s+/g, " ").trim();
    if (!para || para.length > 120) continue;
    if (!isChapterHeading(para)) continue;
    chapters.push({
      index: chapters.length,
      title: para,
      level: headingLevel(para),
      charStart: span.start,
      charEnd: text.length,
    });
  }
  const bounded = dropRepeated(chapters, text.length);
  if (bounded.length === 0) return emptyChapters();
  return {
    version: CHAPTERS_VERSION,
    source: "heading-lines",
    chapters: bounded,
  };
}

export function resolveChapters(
  spoken: string,
  hint: ChapterHint
): ChaptersDocument {
  if (
    (hint.source === "epub-spine" || hint.source === "docx-heading") &&
    hint.titles.length > 0
  ) {
    const aligned = alignTitles(spoken, hint.titles, hint.source);
    if (aligned.chapters.length > 0) return aligned;
  }
  const fromLines = chaptersFromHeadingLines(spoken);
  if (fromLines.chapters.length > 0) return fromLines;
  return emptyChapters();
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
      parsed.source === "docx-heading" ||
      parsed.source === "heading-lines" ||
      parsed.source === "none"
        ? parsed.source
        : "none";
    const chapters: BookChapter[] = [];
    for (const row of parsed.chapters) {
      if (!row || typeof row !== "object") return null;
      const title = typeof row.title === "string" ? row.title.trim() : "";
      if (!title) continue;
      chapters.push({
        index: chapters.length,
        title,
        level: typeof row.level === "number" && row.level > 1 ? row.level : 1,
        charStart: typeof row.charStart === "number" ? row.charStart : 0,
        charEnd: typeof row.charEnd === "number" ? row.charEnd : 0,
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
