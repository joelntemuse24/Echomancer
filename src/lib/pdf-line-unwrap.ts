/**
 * Turn pdf.js / unpdf visual lines back into paragraphs.
 *
 * unpdf's per-page text keeps `hasEOL` newlines. A blind space-join of those
 * lines glues every chapter into one paragraph. This pass dehyphenates, drops
 * page furniture, and only breaks a paragraph when a line is a heading or a
 * short line that already ends a sentence.
 */

import { isChapterHeading } from "@/lib/tts/speakable-text";

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

function shouldBreak(current: string, next: string, median: number): boolean {
  if (isChapterHeading(next) && next.length < 120) return true;
  if (isChapterHeading(current) && current.length < 120) return true;
  const prevShort = current.length < Math.max(24, median * 0.72);
  return endsSentence(current) && prevShort && /^[\p{Lu}"“]/u.test(next);
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

/**
 * Unwrap each page, then join a sentence that crosses the page boundary.
 * A page that already ends a sentence stays a paragraph break.
 */
export function unwrapPdfPages(pages: string[]): string {
  const paras: string[] = [];
  for (const page of pages) {
    const pageParas = unwrapPdfLines(String(page ?? "").split("\n"));
    if (pageParas.length === 0) continue;
    if (paras.length === 0) {
      paras.push(...pageParas);
      continue;
    }
    const prev = paras[paras.length - 1]!;
    const next = pageParas[0]!;
    const cross =
      !endsSentence(prev) &&
      !(isChapterHeading(prev) && prev.length < 120) &&
      !(isChapterHeading(next) && next.length < 120);
    if (cross) {
      paras[paras.length - 1] = joinWrappedLine(prev, next);
      paras.push(...pageParas.slice(1));
    } else {
      paras.push(...pageParas);
    }
  }
  return paras.join("\n\n");
}
