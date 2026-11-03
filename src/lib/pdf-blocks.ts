/**
 * PDF → blocks.
 *
 * `pdf-furniture.ts` already groups pdf.js items into visual lines and marks
 * running heads and page numbers. What it does not do is say which lines are
 * headings — that decision was made later, by regexes over the flattened text,
 * which is why an outline destination could land on the contents page and why
 * "4.2 SQuAD v1.1" could be glued to the sentence above it.
 *
 * Here each visual line is classified once, from the extractor's own evidence:
 *
 * - the line is larger than the page's body text,
 * - or the line is a structural heading shape (`isLayoutHeadingLine`),
 * - or a page's first line continues the previous page's sentence.
 *
 * Lines are then joined into blocks: a heading is its own block, and body lines
 * are unwrapped with the same `unwrapPdfLines` the flat path uses, so the
 * narration string does not change.
 */

import type { BookBlock } from "@/lib/blocks";
import type { PdfPage } from "@/lib/pdf-furniture";
import { unwrapPdfLines } from "@/lib/pdf-line-unwrap";
import { isLayoutHeadingLine, isSpeakableHeading } from "@/lib/tts/speakable-text";

/** Lines this much taller than the page's body text read as headings. */
const HEADING_HEIGHT_RATIO = 1.15;

type PageLines = {
  pageIndex: number;
  lines: { text: string; height: number; heading: boolean }[];
};

function medianHeight(pages: PdfPage[]): number[] {
  return pages.map((page) => {
    const heights = page.lines
      .filter((line) => line.role !== "furniture")
      .map((line) => line.h)
      .sort((a, b) => a - b);
    return heights[Math.floor(heights.length / 2)] ?? 11;
  });
}

/**
 * A tall line is a heading only when it also reads like one. A pull quote or a
 * blown-up first letter is tall and is still prose.
 */
function looksLikeHeading(text: string, tall: boolean): boolean {
  const t = text.trim();
  if (!t) return false;
  if (isLayoutHeadingLine(t)) return true;
  if (tall && t.length <= 120 && isSpeakableHeading(t)) return true;
  return false;
}

/** Content lines of each page, in reading order, with a heading flag. */
export function classifyPdfLines(pages: PdfPage[]): PageLines[] {
  const bodyHeights = medianHeight(pages);
  const out: PageLines[] = [];
  pages.forEach((page, pageIndex) => {
    const bodyHeight = bodyHeights[pageIndex] || 11;
    const lines: PageLines["lines"] = [];
    for (const line of page.lines) {
      if (line.role === "furniture") continue;
      const text = line.text.trim();
      if (!text) continue;
      const tall = line.h > bodyHeight * HEADING_HEIGHT_RATIO;
      lines.push({ text, height: line.h, heading: looksLikeHeading(text, tall) });
    }
    out.push({ pageIndex, lines });
  });
  return out;
}

/**
 * Turn per-page lines into blocks.
 *
 * Body lines are unwrapped per page with the same helper the flat extractor
 * uses, so a sentence that crosses a page break still joins and a heading still
 * keeps its own line. Each block records the PDF page it started on, which is
 * what an outline destination needs.
 */
export function pdfBlocksFromPages(pages: PdfPage[]): BookBlock[] {
  const classified = classifyPdfLines(pages);
  const blocks: BookBlock[] = [];
  let pending: { text: string; page: number } | null = null;

  const flush = () => {
    if (!pending) return;
    blocks.push({ kind: "para", text: pending.text, source: { page: pending.page } });
    pending = null;
  };

  for (const page of classified) {
    if (page.lines.length === 0) continue;
    // Split the page into runs of heading / body lines, keeping each heading
    // on its own.
    let run: string[] = [];
    const emitRun = () => {
      if (run.length === 0) return;
      for (const para of unwrapPdfLines(run)) {
        const text = para.trim();
        if (!text) continue;
        if (pending) {
          pending.text = `${pending.text} ${text}`.replace(/\s+/g, " ").trim();
        } else {
          pending = { text, page: page.pageIndex };
        }
        flush();
      }
      run = [];
    };
    for (const line of page.lines) {
      if (line.heading) {
        emitRun();
        blocks.push({
          kind: "heading",
          level: 1,
          text: line.text,
          source: { page: page.pageIndex },
        });
        continue;
      }
      run.push(line.text);
    }
    emitRun();
  }
  flush();
  return blocks;
}

/**
 * The block a PDF outline destination page starts at.
 *
 * `pageIndex` is 0-based, matching `source.page`. Returns -1 when the document
 * has no block on that page.
 */
export function blockForPdfPage(blocks: BookBlock[], pageIndex: number): number {
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i]!.source?.page === pageIndex) return i;
  }
  // A destination can point one page past the last page with text (a blank
  // closing page); snap to the last block rather than dropping the marker.
  return blocks.length > 0 ? blocks.length - 1 : -1;
}
