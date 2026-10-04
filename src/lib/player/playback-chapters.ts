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
 */

import { withPartContextTitles } from "@/lib/book-chapters";
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
}

/** Where a chapter sits in the frozen pack. `charOffset` is inside that section. */
export interface ChapterSpan {
  title: string;
  sectionIndex: number;
  /** Heading offset within the section. Omitted when the chapter opens it. */
  charOffset?: number;
  sectionChars?: number;
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
      ? { charOffset: point.charOffset, sectionChars: point.sectionChars }
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
        group.charOffset > 0 && group.sectionChars > 0
          ? (group.charOffset / group.sectionChars) * dur
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
