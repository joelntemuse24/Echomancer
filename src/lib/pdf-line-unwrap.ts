/**
 * Turn pdf.js / unpdf visual lines back into paragraphs.
 *
 * unpdf's per-page text keeps `hasEOL` newlines. A blind space-join of those
 * lines glues every chapter into one paragraph. This pass dehyphenates, drops
 * page furniture, and only breaks a paragraph when a line is a heading or a
 * short line that already ends a sentence.
 */

import {
  isBareRomanHeading,
  isChapterHeading,
  isContentsEntryLine,
  isLayoutHeadingLine,
  isStandaloneAllCapsTitle,
} from "@/lib/tts/speakable-text";

export function isPdfFurnitureLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^page\s+\d{1,4}(?:\s+of\s+\d{1,4})?$/i.test(t)) return true;
  if (/^[-–—]\s*\d{1,4}\s*[-–—]$/.test(t)) return true;
  return false;
}

function endsSentence(line: string): boolean {
  return /[.!?]["'”’)\]]*$/u.test(line.trim());
}

function medianLength(lines: string[]): number {
  if (lines.length === 0) return 60;
  const sorted = lines.map((line) => line.length).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] || 60;
}

/** Join a wrapped line. Drop the hyphen only when the next line is lowercase. */
export function joinWrappedLine(current: string, next: string): string {
  if (/[\p{L}]-$/u.test(current) && /^[\p{Ll}]/u.test(next)) {
    return current.slice(0, -1) + next;
  }
  if (/[\p{L}]-$/u.test(current) && /^[\p{L}]/u.test(next)) {
    return current + next;
  }
  return `${current} ${next}`;
}

function isSingleUnpunctuatedWord(line: string): boolean {
  return /^[\p{L}'’‘-]+$/u.test(line.trim());
}

function shouldBreak(current: string, next: string, median: number): boolean {
  if (isLayoutHeadingLine(next) || isLayoutHeadingLine(current)) return true;
  const roman = next.trim();
  if (
    isBareRomanHeading(roman) &&
    !roman.endsWith(".") &&
    endsSentence(current) &&
    !isSingleUnpunctuatedWord(current)
  ) {
    return true;
  }
  if (isStandaloneAllCapsTitle(next) && endsSentence(current)) return true;
  const prevShort = current.length < Math.max(24, median * 0.72);
  return endsSentence(current) && prevShort && /^[\p{Lu}"“]/u.test(next);
}

function isBarePageNumber(line: string): boolean {
  return /^\d{1,4}$/.test(line.trim());
}

function isContentsBanner(line: string): boolean {
  return /^(?:contents|table of contents)$/i.test(line.trim());
}

/** A contents line is a label, not a wrapped lowercase sentence. */
function looksLikeContentsLabel(line: string): boolean {
  const t = line.trim();
  if (!t || isBarePageNumber(t)) return false;
  if (isContentsBanner(t) || isContentsEntryLine(t)) return true;
  if (/^(?:chapter|part|book|volume|section|preface|introduction)\b/i.test(t)) return true;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 14) return false;
  const caps = words.filter((word) => /^\p{Lu}/u.test(word)).length;
  return caps / words.length >= 0.6 && !/[.!?]\s+\p{Ll}/u.test(t);
}

/** A contents page is the banner, or a continuation of label lines rather than prose. */
export function isContentsPage(lines: string[], continuing = false): boolean {
  const content = lines.map((line) => line.trim()).filter((line) => line && !isBarePageNumber(line));
  if (content.some(isContentsBanner)) return true;
  if (!continuing || content.length === 0) return false;
  if (content.some((line) => line.length > 180)) return false;
  const labels = content.filter(looksLikeContentsLabel).length;
  return labels / content.length >= 0.6;
}

/** Each contents line stays its own paragraph. Bare page numbers are dropped. */
export function contentsParagraphs(lines: string[]): string[] {
  const paras: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || isPdfFurnitureLine(line) || isBarePageNumber(line)) continue;
    paras.push(line);
  }
  return paras;
}

/** Paragraphs from one page (or one already-blank-separated block) of lines. */
export function unwrapPdfLines(lines: string[]): string[] {
  const trimmed = lines.map((line) => line.trim());
  const content = trimmed.filter((line) => line && !isPdfFurnitureLine(line));
  const median = medianLength(content);
  const paras: string[] = [];
  let current = "";

  const flush = () => {
    if (current) paras.push(current);
    current = "";
  };

  for (const raw of trimmed) {
    if (!raw) {
      flush();
      continue;
    }
    if (isPdfFurnitureLine(raw)) continue;
    if (!current) {
      current = raw;
      continue;
    }
    if (shouldBreak(current, raw, median)) {
      flush();
      current = raw;
      continue;
    }
    current = joinWrappedLine(current, raw);
  }
  flush();
  return paras;
}

function keepsItsOwnLine(line: string): boolean {
  return (
    (isChapterHeading(line) && line.length < 120) ||
    isLayoutHeadingLine(line) ||
    isContentsBanner(line)
  );
}

/**
 * Unwrap each page, then join a sentence that crosses the page boundary.
 * A page that already ends a sentence stays a paragraph break.
 * `pageStarts[i]` is the char offset where PDF page i begins.
 */
export function unwrapPdfPagesDetailed(pages: string[]): {
  text: string;
  pageStarts: number[];
} {
  const paras: string[] = [];
  const pageStarts: number[] = [];
  let contents = false;
  for (let p = 0; p < pages.length; p++) {
    const lines = String(pages[p] ?? "").split("\n");
    const onContents = isContentsPage(lines, contents);
    const pageParas = onContents ? contentsParagraphs(lines) : unwrapPdfLines(lines);
    contents = onContents;
    const before = paras.join("\n\n");
    if (pageParas.length === 0) {
      pageStarts[p] = before.length;
      continue;
    }
    if (paras.length === 0 || onContents) {
      pageStarts[p] = before.length === 0 ? 0 : before.length + 2;
      paras.push(...pageParas);
      continue;
    }
    const prev = paras[paras.length - 1]!;
    const next = pageParas[0]!;
    const cross =
      !endsSentence(prev) &&
      !keepsItsOwnLine(prev) &&
      !keepsItsOwnLine(next);
    if (cross) {
      const joined = joinWrappedLine(prev, next);
      pageStarts[p] = before.length - prev.length + (joined.length - next.length);
      paras[paras.length - 1] = joined;
      paras.push(...pageParas.slice(1));
    } else {
      pageStarts[p] = before.length + 2;
      paras.push(...pageParas);
    }
  }
  return { text: paras.join("\n\n"), pageStarts };
}

/** Unwrap each page, then join a sentence that crosses the page boundary. */
export function unwrapPdfPages(pages: string[]): string {
  return unwrapPdfPagesDetailed(pages).text;
}

/** Lines from the contents pages, still one entry per visual line. */
export function contentsLinesFromPages(pages: string[]): string[] {
  const lines: string[] = [];
  let contents = false;
  for (const page of pages) {
    const pageLines = String(page ?? "").split("\n");
    const onContents = isContentsPage(pageLines, contents);
    if (!onContents) {
      if (contents) break;
      continue;
    }
    contents = true;
    lines.push(...contentsParagraphs(pageLines));
  }
  return lines;
}
