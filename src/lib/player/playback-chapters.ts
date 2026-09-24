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

import type { FrozenSection, JobSegment } from "@/lib/tts/types";

export interface PlaybackChapter {
  index: number;
  title: string;
  /** 0–1 into the concatenated audiobook. */
  startFraction: number;
}

type OutlineSection = Pick<
  FrozenSection,
  "index" | "chapterIndex" | "chapterTitle" | "charStart" | "charEnd"
>;

function roundFraction(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 10000) / 10000;
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
  const groups: Array<{
    chapterIndex: number;
    title: string | null;
    firstIndex: number;
    charStart: number;
  }> = [];

  for (const section of ordered) {
    const title = section.chapterTitle?.replace(/\s+/g, " ").trim() || null;
    const last = groups[groups.length - 1];
    if (!last || last.chapterIndex !== section.chapterIndex) {
      groups.push({
        chapterIndex: section.chapterIndex,
        title,
        firstIndex: section.index,
        charStart: section.charStart,
      });
    } else if (!last.title && title) {
      last.title = title;
    }
  }

  const titled = groups.filter((group) => group.title);
  if (titled.length === 0) return [];

  const allTimed = ordered.every((section) => durationByIndex.has(section.index));
  const knownSum = allTimed
    ? ordered.reduce((sum, section) => sum + (durationByIndex.get(section.index) ?? 0), 0)
    : 0;
  const totalChars = ordered.reduce((max, section) => Math.max(max, section.charEnd), 0);
  const useDurations = allTimed && knownSum > 0;
  if (!useDurations && totalChars <= 0) return [];

  const chapters: PlaybackChapter[] = [];
  for (const group of titled) {
    let fraction = 0;
    if (useDurations) {
      const prior = ordered
        .filter((section) => section.index < group.firstIndex)
        .reduce((sum, section) => sum + (durationByIndex.get(section.index) ?? 0), 0);
      fraction = prior / knownSum;
    } else {
      fraction = group.charStart / totalChars;
    }
    if (!Number.isFinite(fraction)) continue;
    chapters.push({
      index: chapters.length,
      title: group.title!,
      startFraction: roundFraction(fraction),
    });
  }
  return chapters;
}
