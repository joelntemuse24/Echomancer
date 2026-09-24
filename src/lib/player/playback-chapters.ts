/**
 * Chapter starts in a finished whole-book file.
 *
 * Synthesis windows stay "Section 1, Section 2" while a book is generating.
 * Once it is ready, titled chapters from the frozen pack replace that list.
 * A window after the heading keeps the same `chapterIndex` with a null title,
 * so titles are taken from the first window of each chapter.
 */

import type { FrozenSection, JobSegment } from "@/lib/tts/types";

export interface PlaybackChapter {
  index: number;
  title: string;
  /** Seconds into the concatenated audiobook. */
  startSeconds: number;
}

type OutlineSection = Pick<
  FrozenSection,
  "index" | "chapterIndex" | "chapterTitle" | "charStart" | "charEnd"
>;

export function playbackChaptersFromSections(
  sections: OutlineSection[],
  segments: Array<Pick<JobSegment, "index" | "durationSeconds">> | null | undefined,
  totalDurationSeconds?: number | null
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

  const knownSum = ordered.reduce(
    (sum, section) => sum + (durationByIndex.get(section.index) ?? 0),
    0
  );
  const allTimed = ordered.every((section) => durationByIndex.has(section.index));
  const totalChars = ordered.reduce(
    (max, section) => Math.max(max, section.charEnd),
    0
  );
  const bookDuration =
    typeof totalDurationSeconds === "number" && totalDurationSeconds > 0
      ? totalDurationSeconds
      : knownSum;

  const startFor = (sectionIndex: number, charStart: number): number | null => {
    const prior = ordered.filter((section) => section.index < sectionIndex);
    if (prior.every((section) => durationByIndex.has(section.index))) {
      const raw = prior.reduce(
        (sum, section) => sum + (durationByIndex.get(section.index) ?? 0),
        0
      );
      if (allTimed && knownSum > 0 && bookDuration > 0) {
        return (raw / knownSum) * bookDuration;
      }
      return raw;
    }
    if (bookDuration > 0 && totalChars > 0) {
      return (charStart / totalChars) * bookDuration;
    }
    return null;
  };

  const chapters: PlaybackChapter[] = [];
  for (const group of titled) {
    const start = startFor(group.firstIndex, group.charStart);
    if (start == null || !Number.isFinite(start)) return [];
    chapters.push({
      index: chapters.length,
      title: group.title!,
      startSeconds: Math.round(Math.max(0, start) * 10) / 10,
    });
  }
  return chapters;
}
