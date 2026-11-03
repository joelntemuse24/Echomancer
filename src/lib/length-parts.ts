/**
 * Length-based parts, for a book that has no chapter markers at all.
 *
 * Some books genuinely do not mark their sections: Ulysses prints no chapter
 * numbers, and its only all-caps lines are newspaper headlines inside one
 * episode. A heading detector that fires on those produces sixty "chapters"
 * that are not chapters, and an empty outline gives the player nothing.
 *
 * So a book with no usable markers is split into equal parts at paragraph
 * boundaries, and the parts are labelled. Never invented *titles* — the labels
 * say "Part 1", not a chapter name that was never printed.
 */

import {
  CHAPTERS_VERSION,
  type BookChapter,
  type ChaptersDocument,
} from "@/lib/book-chapters";
import { paragraphSpans } from "@/lib/paragraph-spans";

/** Target characters per part. A typical novel chapter is a little longer. */
export const LENGTH_PART_CHARS = 80_000;
export const MIN_LENGTH_PARTS = 2;
export const MAX_LENGTH_PARTS = 24;

/** How many parts this book should have. */
export function lengthPartCount(chars: number): number {
  const wanted = Math.round(chars / LENGTH_PART_CHARS);
  return Math.min(MAX_LENGTH_PARTS, Math.max(MIN_LENGTH_PARTS, wanted));
}

/**
 * Split at the paragraph nearest each equal-length boundary, so a part never
 * starts mid-sentence.
 */
export function splitIntoLengthParts(
  spoken: string,
  parts = lengthPartCount(spoken.length)
): number[] {
  const spans = paragraphSpans(spoken);
  if (spans.length === 0) return [0];
  const starts: number[] = [0];
  for (let part = 1; part < parts; part++) {
    const target = Math.round((spoken.length * part) / parts);
    let best = -1;
    let bestDistance = Infinity;
    for (const span of spans) {
      if (span.start <= (starts[starts.length - 1] ?? 0)) continue;
      const distance = Math.abs(span.start - target);
      if (distance < bestDistance) {
        best = span.start;
        bestDistance = distance;
      }
    }
    if (best > (starts[starts.length - 1] ?? 0)) starts.push(best);
  }
  return starts;
}

/** A labelled part list for a book with no markers of its own. */
export function chaptersFromLength(spoken: string): ChaptersDocument {
  if (!spoken.trim()) {
    return { version: CHAPTERS_VERSION, source: "none", chapters: [] };
  }
  const starts = splitIntoLengthParts(spoken);
  const chapters: BookChapter[] = starts.map((start, index) => ({
    index,
    title: `Part ${index + 1}`,
    level: 1,
    charStart: start,
    charEnd: starts[index + 1] ?? spoken.length,
  }));
  return { version: CHAPTERS_VERSION, source: "sections", chapters };
}

/**
 * True when an outline is a bad reading of a book that has no real chapter
 * markers.
 *
 * Two signals, either of which is enough:
 *
 * - Almost nothing in it is a chapter label, and the markers sit so close
 *   together that each one covers far less than a part.
 * - The printed lines are all shouted headings (Ulysses' episode prints
 *   newspaper headlines in caps), so the "chapters" are in-page headings of one
 *   section.
 *
 * Only a heading-line outline is eligible: an EPUB, PDF, or HTML outline came
 * from the source's own structure and is never second-guessed here.
 */
export function outlineLooksUnmarked(
  chapters: BookChapter[],
  textLength: number,
  source?: string
): boolean {
  if (source && source !== "heading-lines") return false;
  // Two parts is a real answer for a short unmarked work (Metamorphosis).
  if (chapters.length < 3) return false;
  const titles = chapters.map((chapter) => chapter.title.trim());
  const labelled = titles.filter((title) =>
    /^(?:\d{1,3}(?:\.\d+)*|[A-H](?:\.\d+)*|[IVXLCDM]{1,8})\b|^(?:chapter|part|book|volume|section|letter|act|scene|canto|stave|prologue|epilogue|preface|introduction|foreword|afterword|appendix|notes|endnotes|contents)\b/i.test(
      title
    )
  );
  if (labelled.length * 2 >= chapters.length) return false;
  // Every printed line an all-caps heading: these are in-page headings (a
  // newspaper column, a diary head), not chapters.
  const printed = chapters.map((chapter) => (chapter.match ?? chapter.title).trim());
  const shouted = printed.filter((title) => title.length > 3 && !/\p{Ll}/u.test(title)).length;
  if (shouted * 2 >= chapters.length) return true;
  // Real chapters are long. A run of markers averaging under half a part is a
  // headline list, not an outline.
  return textLength / chapters.length < LENGTH_PART_CHARS / 2;
}
