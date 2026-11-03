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
 * True when an outline is not a chapter list at all.
 *
 * Both signals have to hold:
 *
 * - nothing in it is a chapter label (`CHAPTER I`, `Part Two`, `12`), and
 * - the printed lines are all *shouted* headings.
 *
 * That is Ulysses, whose only capitalised headings are the newspaper headlines
 * inside one episode: sixty of them, none a chapter. A book whose headings are
 * "CHAPTER I." is not this, because the label check sees them. A scientific
 * paper with "Introduction" / "Results" is not this either, because its titles
 * are not shouted and its sections are real.
 *
 * Only a heading-line outline is eligible. An EPUB, PDF-outline, or HTML
 * outline came from the source's own structure and is never second-guessed.
 */
const CHAPTER_LABEL_RE =
  /^(?:\d{1,3}(?:\.\d+)*|[A-H](?:\.\d+)*|[IVXLCDM]{1,8})\b|^(?:chapter|part|book|volume|section|letter|act|scene|canto|stave|prologue|epilogue|preface|introduction|foreword|afterword|appendix|notes|endnotes|contents)\b/i;

/** An in-page head, not a chapter label: "A Collision Ensues", "The Wearer". */
const SHORT_HEAD_RE = /^(?:a|an|the)\s+\p{L}/iu;

export function outlineLooksUnmarked(
  chapters: BookChapter[],
  source?: string
): boolean {
  if (source && source !== "heading-lines") return false;
  // Two parts is a real answer for a short unmarked work (Metamorphosis).
  if (chapters.length < 6) return false;
  // Even a minority of real chapter labels means this IS a chapter list that
  // also picked up some in-page heads. Dracula is 28 labelled chapters and 39
  // diary heads; it is a chaptered book, not an unmarked one.
  const labelled = chapters.filter((chapter) => {
    const title = chapter.title.trim();
    if (!CHAPTER_LABEL_RE.test(title)) return false;
    // "A Collision Ensues" starts with an article; a bare roman numeral does
    // not. Only a numeral, a dotted number, or a structural label counts.
    return !SHORT_HEAD_RE.test(title);
  });
  if (labelled.length >= 3) return false;
  const printed = chapters.map((chapter) => (chapter.match ?? chapter.title).trim());
  const shouted = printed.filter(
    (line) =>
      line.length > 3 && line.length <= 120 && !/\p{Ll}/u.test(line) && /\p{L}/u.test(line)
  ).length;
  return shouted * 2 >= printed.length;
}
