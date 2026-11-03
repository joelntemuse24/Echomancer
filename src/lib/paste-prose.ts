/**
 * Paragraph repairs for pasted text and fetched pages.
 *
 * A web page or a copy out of a browser often puts a blank line in the
 * middle of a sentence. Uploaded PDFs already unwrap those wraps; this pass
 * is what a paste or a URL gets before the shared speakable cleanup.
 */

const SENTENCE_END = /[.!?:;"”’]["”’)\]]*$/u;

const TITLE_SMALL = new Set([
  "a",
  "an",
  "the",
  "of",
  "and",
  "or",
  "but",
  "to",
  "in",
  "on",
  "for",
  "with",
  "from",
  "by",
  "at",
  "as",
  "into",
  "over",
  "under",
]);

/** A decorative drop cap copied twice: "R Ravi avi" is "Ravi". */
export function collapseDropCap(text: string): string {
  return text.replace(/\b(\p{Lu})\s+\1(\p{Ll}{2,})\s+\2\b/gu, "$1$2");
}

function significantWords(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);
}

/** Short title-case line: a heading, not a sentence that lost its period. */
function isShortTitleCase(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 80) return false;
  const words = significantWords(t);
  if (words.length === 0 || words.length > 12) return false;
  let titled = 0;
  for (const word of words) {
    if (TITLE_SMALL.has(word.toLowerCase())) continue;
    if (!/^\p{Lu}/u.test(word)) return false;
    titled += 1;
  }
  return titled > 0;
}

function isAllCapsLine(text: string): boolean {
  const t = text.trim();
  if (t.length < 3 || t.length > 80) return false;
  if (/\p{Ll}/u.test(t) || !/\p{Lu}/u.test(t)) return false;
  return t.split(/\s+/).length <= 12;
}

function isKeptHeading(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 80) return false;
  if (/^(?:contents|table of contents)$/i.test(t)) return true;
  if (/^(?:chapter|part|section|book|volume)\b/i.test(t)) return true;
  if (/^(?:foreword|preface|prologue|epilogue|introduction|afterword|notes|endnotes)\.?$/i.test(t)) {
    return true;
  }
  return /^(?:[IVXLCDM]{2,8})\.?$/i.test(t);
}

function leadingLetter(text: string): "lower" | "upper" | null {
  const t = text.trim().replace(/^["“‘']+/u, "");
  if (/^\p{Ll}/u.test(t)) return "lower";
  if (/^\p{Lu}/u.test(t)) return "upper";
  return null;
}

/**
 * Two short lines with no sentence end are list items ("water" / "batteries"),
 * not a sentence that was split. A continuation still has the rest of the
 * sentence, so it keeps a period or is long enough to be prose.
 */
function isListItemPair(prev: string, next: string): boolean {
  const prevWords = prev.split(/\s+/).filter(Boolean);
  const nextWords = next.split(/\s+/).filter(Boolean);
  if (prevWords.length > 4 || prev.length > 48) return false;
  if (nextWords.length > 6 || next.length > 48) return false;
  if (/[.!?]/.test(next)) return false;
  return true;
}

/**
 * Join two blank-line blocks that are one sentence.
 *
 * "they ultimately create" / "wealth." becomes one line. So does
 * "the commanding" / "Heights", where the next word is a name.
 * A short title-case heading stays apart from the sentence under it.
 */
export function rejoinBrokenParagraphs(text: string): string {
  const blocks = text.split(/\n\s*\n/);
  const out: string[] = [];
  for (const raw of blocks) {
    const block = raw.replace(/[^\S\n]+/g, " ").trim();
    if (!block) continue;
    const prev = out[out.length - 1];
    if (!prev) {
      out.push(block);
      continue;
    }
    const start = leadingLetter(block);
    const heading =
      isKeptHeading(prev) ||
      isKeptHeading(block) ||
      isAllCapsLine(prev) ||
      (isShortTitleCase(prev) && start === "upper");
    const join =
      !SENTENCE_END.test(prev) &&
      !heading &&
      !isListItemPair(prev, block) &&
      (start === "lower" || start === "upper");
    if (join) {
      out[out.length - 1] = `${prev} ${block}`;
    } else {
      out.push(block);
    }
  }
  return out.join("\n\n");
}

/** Drop-cap collapse, then mid-sentence blank lines rejoined. */
export function tidyPastedProse(text: string): string {
  if (!text.trim()) return text.trim();
  return rejoinBrokenParagraphs(collapseDropCap(text));
}
