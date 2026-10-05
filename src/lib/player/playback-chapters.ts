/**
 * Chapter starts in a finished whole-book file.
 *
 * Synthesis windows stay "Section 1, Section 2" while a book is generating.
 * Once it is ready, titled chapters from the frozen pack replace that list.
 * A window after the heading keeps the same `chapterIndex` with a null title,
 * so titles are taken from the first window of each chapter.
 *
 * The position is a fraction of the finished file. The player multiplies by
 * the audio element's duration, which is the file it is actually seeking.
 * Section durations are used only when every window has one. Otherwise the
 * fraction is the heading's character offset. One clock for the whole book:
 * a missing duration never mixes a raw second sum with a character fraction.
 * A heading inside a section is timed from the speakable text up to that
 * heading's paragraph when the section text is available.
 */

import { withPartContextTitles } from "@/lib/book-chapters";
import { headingOffsetSeconds } from "@/lib/player/heading-placement";
import { narratedHeadingOffset, placeTopicPhrase } from "@/lib/printed-toc";
import type { FrozenSection, JobSegment } from "@/lib/tts/types";

export interface PlaybackChapter {
  index: number;
  title: string;
  /** 0–1 into the concatenated audiobook. */
  startFraction: number;
  /** Measured position in the finished file, when finalize timed the audio. */
  startSeconds?: number;
  /** Measured chapter end (the next chapter's start, or the file end). */
  endSeconds?: number;
  subtitle?: string;
  level?: number;
  children?: PlaybackChapter[];
  /** Offset in the speakable text. Kept so finalize can retime the same tree. */
  charStart?: number;
}

/** Where a chapter sits in the frozen pack. `charOffset` is inside that section. */
export interface ChapterSpan {
  title: string;
  sectionIndex: number;
  /** Heading offset within the section. Omitted when the chapter opens it. */
  charOffset?: number;
  sectionChars?: number;
  /** Section window. Present when a mid-section heading can be timed from speech. */
  sectionText?: string;
}

type OutlineSection = Pick<
  FrozenSection,
  "index" | "chapterIndex" | "chapterTitle" | "charStart" | "charEnd" | "text" | "chapterMarks"
>;

type ChapterPoint = {
  chapterIndex: number;
  title: string | null;
  sectionIndex: number;
  charStart: number;
  charOffset: number;
  sectionChars: number;
  sectionText?: string;
};

function cleanTitle(title: string | null | undefined): string | null {
  const cleaned = title?.replace(/\s+/g, " ").trim() || "";
  return cleaned || null;
}

function sectionCharsOf(section: OutlineSection): number {
  if (typeof section.text === "string" && section.text.length > 0) return section.text.length;
  return Math.max(1, section.charEnd - section.charStart);
}

/** One point per titled chapter, including headings absorbed into a section. */
function chapterPoints(sections: OutlineSection[]): ChapterPoint[] {
  const ordered = [...sections].sort((a, b) => a.index - b.index);
  const points: ChapterPoint[] = [];
  for (const section of ordered) {
    const title = cleanTitle(section.chapterTitle);
    const sectionChars = sectionCharsOf(section);
    const last = points[points.length - 1];
    if (!last || last.chapterIndex !== section.chapterIndex) {
      points.push({
        chapterIndex: section.chapterIndex,
        title,
        sectionIndex: section.index,
        charStart: section.charStart,
        charOffset: 0,
        sectionChars,
        ...(section.text ? { sectionText: section.text } : {}),
      });
    } else if (!last.title && title) {
      last.title = title;
    }
    for (const mark of section.chapterMarks ?? []) {
      const markTitle = cleanTitle(mark.title);
      if (!markTitle) continue;
      const current = points[points.length - 1];
      if (current && current.chapterIndex === mark.chapterIndex) {
        if (!current.title) {
          current.title = markTitle;
          current.charOffset = mark.charOffset;
          current.charStart = section.charStart + mark.charOffset;
          current.sectionIndex = section.index;
          current.sectionChars = sectionChars;
          if (section.text) current.sectionText = section.text;
        }
        continue;
      }
      points.push({
        chapterIndex: mark.chapterIndex,
        title: markTitle,
        sectionIndex: section.index,
        charStart: section.charStart + mark.charOffset,
        charOffset: mark.charOffset,
        sectionChars,
        ...(section.text ? { sectionText: section.text } : {}),
      });
    }
  }
  return points;
}

function roundFraction(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 10000) / 10000;
}

function roundSeconds(value: number): number {
  return Math.round(Math.max(0, value) * 1000) / 1000;
}

/**
 * One entry per titled chapter run: the display title and the first section
 * index of that chapter. This is the outline finalize timestamps.
 */
export function chapterSpansFromSections(sections: OutlineSection[]): ChapterSpan[] {
  const titled = chapterPoints(sections).filter((point) => point.title);
  const titles = withPartContextTitles(titled.map((point) => point.title!));
  return titled.map((point, i) => ({
    title: titles[i]!,
    sectionIndex: point.sectionIndex,
    ...(point.charOffset > 0
      ? {
          charOffset: point.charOffset,
          sectionChars: point.sectionChars,
          ...(point.sectionText ? { sectionText: point.sectionText } : {}),
        }
      : {}),
  }));
}

/**
 * Chapters with measured positions. `sectionStarts[i]` is section i's start
 * in the finished file; a chapter starts where its first section starts and
 * ends where the next chapter starts (or at the file end).
 */
function measuredChapterStart(span: ChapterSpan, sectionStarts: number[], totalSeconds: number): number | null {
  const start = sectionStarts[span.sectionIndex];
  if (typeof start !== "number" || !Number.isFinite(start)) return null;
  const offset = span.charOffset ?? 0;
  const chars = span.sectionChars ?? 0;
  if (offset <= 0 || chars <= 0) return start;
  const next = sectionStarts[span.sectionIndex + 1];
  const end = typeof next === "number" && Number.isFinite(next) ? next : totalSeconds;
  const duration = Math.max(0, end - start);
  if (span.sectionText) return start + headingOffsetSeconds(span.sectionText, offset, duration);
  return start + (offset / chars) * duration;
}

export function playbackChaptersWithTimes(
  spans: ChapterSpan[],
  sectionStarts: number[],
  totalSeconds: number
): PlaybackChapter[] {
  if (spans.length === 0 || !(totalSeconds > 0)) return [];
  const chapters: PlaybackChapter[] = [];
  for (const span of spans) {
    const start = measuredChapterStart(span, sectionStarts, totalSeconds);
    if (start == null) continue;
    chapters.push({
      index: chapters.length,
      title: span.title,
      startFraction: roundFraction(start / totalSeconds),
      startSeconds: roundSeconds(start),
    });
  }
  for (let i = 0; i < chapters.length; i++) {
    const next = chapters[i + 1];
    chapters[i] = {
      ...chapters[i]!,
      endSeconds: roundSeconds(next ? next.startSeconds! : totalSeconds),
    };
  }
  return chapters;
}

export function playbackChaptersFromSections(
  sections: OutlineSection[],
  segments?: Array<Pick<JobSegment, "index" | "durationSeconds">> | null
): PlaybackChapter[] {
  if (sections.length === 0) return [];

  const durationByIndex = new Map<number, number>();
  for (const segment of segments || []) {
    if (
      typeof segment.index === "number" &&
      typeof segment.durationSeconds === "number" &&
      segment.durationSeconds > 0
    ) {
      durationByIndex.set(segment.index, segment.durationSeconds);
    }
  }

  const ordered = [...sections].sort((a, b) => a.index - b.index);
  const titled = chapterPoints(sections).filter((point) => point.title);
  if (titled.length === 0) return [];
  const titles = withPartContextTitles(titled.map((point) => point.title!));

  const allTimed = ordered.every((section) => durationByIndex.has(section.index));
  const knownSum = allTimed
    ? ordered.reduce((sum, section) => sum + (durationByIndex.get(section.index) ?? 0), 0)
    : 0;
  const totalChars = ordered.reduce((max, section) => Math.max(max, section.charEnd), 0);
  const useDurations = allTimed && knownSum > 0;
  if (!useDurations && totalChars <= 0) return [];

  const chapters: PlaybackChapter[] = [];
  for (let i = 0; i < titled.length; i++) {
    const group = titled[i]!;
    let fraction = 0;
    if (useDurations) {
      const prior = ordered
        .filter((section) => section.index < group.sectionIndex)
        .reduce((sum, section) => sum + (durationByIndex.get(section.index) ?? 0), 0);
      const dur = durationByIndex.get(group.sectionIndex) ?? 0;
      const into =
        group.charOffset > 0 && dur > 0
          ? group.sectionText
            ? headingOffsetSeconds(group.sectionText, group.charOffset, dur)
            : group.sectionChars > 0
              ? (group.charOffset / group.sectionChars) * dur
              : 0
          : 0;
      fraction = (prior + into) / knownSum;
    } else {
      fraction = group.charStart / totalChars;
    }
    if (!Number.isFinite(fraction)) continue;
    chapters.push({
      index: chapters.length,
      title: titles[i]!,
      startFraction: roundFraction(fraction),
    });
  }
  return chapters;
}

export interface PlaybackSourceChapter {
  title: string;
  subtitle?: string;
  level?: number;
  charStart: number;
  match?: string;
  children?: PlaybackSourceChapter[];
}

function findBounded(text: string, needle: string, from: number, end: number): number {
  const sample = needle.replace(/\s+/g, " ").trim().slice(0, 80);
  if (sample.length < 3) return -1;
  const folded = text.toLowerCase();
  const want = sample.toLowerCase();
  let at = folded.indexOf(want, from);
  while (at >= 0 && at < end) {
    const before = at === 0 || !/[a-z0-9]/i.test(folded[at - 1] ?? "");
    const afterAt = at + want.length;
    const after = afterAt >= folded.length || !/[a-z0-9]/i.test(folded[afterAt] ?? "");
    if (before && after) return at;
    at = folded.indexOf(want, at + 1);
  }
  return -1;
}

function headingStillThere(text: string, chapter: PlaybackSourceChapter): boolean {
  const needle = (chapter.match || chapter.title).replace(/\s+/g, " ").trim().slice(0, 80);
  if (needle.length < 3 || chapter.charStart < 0 || chapter.charStart > text.length) return false;
  const slice = text
    .slice(chapter.charStart, chapter.charStart + needle.length)
    .replace(/\s+/g, " ")
    .trim();
  return slice.toLowerCase() === needle.toLowerCase();
}

/** Move a stored tree onto the speakable text the audio was packed from. */
export function anchorChapterTree(
  chapters: PlaybackSourceChapter[],
  text: string
): PlaybackSourceChapter[] {
  const out: PlaybackSourceChapter[] = [];
  let cursor = 0;
  const kept: boolean[] = [];
  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i]!;
    const still = chapter.charStart >= cursor && headingStillThere(text, chapter);
    const at = still
      ? chapter.charStart
      : narratedHeadingOffset(text, chapter.match || chapter.title, cursor);
    if (at < 0) continue;
    out.push({ ...chapter, charStart: at });
    kept.push(still);
    cursor = at + 1;
  }
  for (let i = 0; i < out.length; i++) {
    const end = out[i + 1]?.charStart ?? text.length;
    const source = out[i]!.children;
    if (!source?.length) continue;
    const children = kept[i]
      ? source.filter(
          (child) => child.charStart >= out[i]!.charStart && child.charStart < end
        )
      : anchorChildren(source, text, out[i]!.charStart, end);
    if (children.length > 0) out[i]!.children = children;
    else delete out[i]!.children;
  }
  return out;
}

function anchorChildren(
  children: PlaybackSourceChapter[],
  text: string,
  from: number,
  end: number
): PlaybackSourceChapter[] {
  const out: PlaybackSourceChapter[] = [];
  let cursor = from;
  for (const child of children) {
    let at = findBounded(text, child.title, cursor, end);
    if (at < 0) {
      const local = placeTopicPhrase(text.slice(cursor, end), child.title, 0);
      if (local != null) at = cursor + local;
    }
    if (at < 0 || at >= end) continue;
    out.push({ ...child, charStart: at });
    cursor = at + 1;
  }
  return out;
}

export function playbackTreeFromCharStarts(
  chapters: PlaybackSourceChapter[],
  textLength: number
): PlaybackChapter[] {
  const total = Math.max(1, textLength);
  return chapters.map((chapter, index) => ({
    index,
    title: chapter.title,
    level: chapter.level ?? 1,
    startFraction: roundFraction(chapter.charStart / total),
    charStart: chapter.charStart,
    ...(chapter.subtitle ? { subtitle: chapter.subtitle } : {}),
    ...(chapter.children?.length
      ? { children: playbackTreeFromCharStarts(chapter.children, textLength) }
      : {}),
  }));
}

function secondsAtChar(
  charStart: number,
  sections: Array<{ charStart: number; charEnd: number; text?: string }>,
  sectionStarts: number[],
  totalSeconds: number
): number | null {
  let sectionIndex = -1;
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    if (charStart >= section.charStart && charStart < section.charEnd) {
      sectionIndex = i;
      break;
    }
  }
  if (sectionIndex < 0 && sections.length > 0 && charStart >= sections[sections.length - 1]!.charStart) {
    sectionIndex = sections.length - 1;
  }
  if (sectionIndex < 0) return null;
  const start = sectionStarts[sectionIndex];
  if (typeof start !== "number" || !Number.isFinite(start)) return null;
  const section = sections[sectionIndex]!;
  const chars = Math.max(1, section.charEnd - section.charStart);
  const offset = Math.max(0, Math.min(chars, charStart - section.charStart));
  const next = sectionStarts[sectionIndex + 1];
  const end = typeof next === "number" && Number.isFinite(next) ? next : totalSeconds;
  const duration = Math.max(0, end - start);
  if (section.text) {
    const local =
      section.text.length > 0 && section.text.length !== chars
        ? Math.round((offset / chars) * section.text.length)
        : offset;
    return start + headingOffsetSeconds(section.text, local, duration);
  }
  return start + (offset / chars) * duration;
}

function withMeasuredEnds(chapters: PlaybackChapter[], endSeconds: number): PlaybackChapter[] {
  return chapters.map((chapter, index) => {
    const next = chapters[index + 1]?.startSeconds ?? endSeconds;
    const children = chapter.children?.length
      ? withMeasuredEnds(chapter.children, next)
      : undefined;
    return {
      ...chapter,
      endSeconds: roundSeconds(next),
      ...(children && children.length > 0 ? { children } : {}),
    };
  });
}

/** Fill startSeconds from section audio. A chapter with no charStart is dropped. */
export function timePlaybackTree(
  chapters: PlaybackChapter[],
  sections: Array<{ charStart: number; charEnd: number; text?: string }>,
  sectionStarts: number[],
  totalSeconds: number
): PlaybackChapter[] {
  if (!(totalSeconds > 0)) return [];
  const timed = chapters.flatMap((chapter) => {
    if (typeof chapter.charStart !== "number") return [];
    const start = secondsAtChar(chapter.charStart, sections, sectionStarts, totalSeconds);
    if (start == null) return [];
    const children = chapter.children?.length
      ? timePlaybackTree(chapter.children, sections, sectionStarts, totalSeconds)
      : undefined;
    return [
      {
        ...chapter,
        startSeconds: roundSeconds(start),
        startFraction: roundFraction(start / totalSeconds),
        ...(children && children.length > 0 ? { children } : {}),
      },
    ];
  });
  return withMeasuredEnds(timed, totalSeconds);
}
