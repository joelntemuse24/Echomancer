/**
 * PDF → blocks.
 *
 * `pdf-furniture.ts` groups pdf.js items into visual lines and marks running
 * heads and page numbers. What it does not do is say which lines are headings —
 * that decision was made later, by regexes over the flattened text, which is why
 * an outline destination could land on the contents page and why
 * "4.2 SQuAD v1.1" could be glued to the sentence above it.
 *
 * Here each visual line is classified once, from the extractor's own evidence:
 *
 * - the line reads like a heading shape (`isLayoutHeadingLine`,
 *   `isSpeakableHeading`), or
 * - it is taller than the page's body text and reads like a title.
 *
 * The blocks exist so an embedded outline can name a *block* instead of a
 * page offset that has to be re-found in the prose.
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

const HEADING_FUNCTION_WORD =
  /^(?:a|an|the|of|and|or|but|to|in|on|for|with|from|by|at|as|into|over|under|its|his|her|their|our|this|that|these|those)$/i;


/**
 * A heading, from the extractor's own evidence: a heading shape, or a line set
 * larger than the page's body text.
 *
 * Deliberately conservative. A PDF has no markup to say which line is a title,
 * so guessing produces table rows and figure labels as chapters — which is
 * exactly what the corpus showed when a bare-title rule was tried here. The
 * embedded outline is the reliable answer for a PDF; this is only its fallback.
 */
function looksLikeHeading(text: string, tall: boolean): boolean {
  const t = text.trim();
  if (!t) return false;
  if (isLayoutHeadingLine(t) || isSpeakableHeading(t)) return true;
  if (t.length > 120 || t.length > 80) return false;
  if (!tall) return false;
  return !/[.!?]$/.test(t) && !/^\p{Ll}/u.test(t);
}

function median(values: number[]): number {
  if (values.length === 0) return 11;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 11;
}

/**
 * Turn per-page lines into blocks.
 *
 * Body lines are unwrapped per page with the same helper the flat extractor
 * uses, so a sentence that crosses a page break still joins and a heading keeps
 * its own line. Each block records the PDF page it started on, which is what an
 * outline destination needs.
 */
export function pdfBlocksFromPages(pages: PdfPage[]): BookBlock[] {
  const blocks: BookBlock[] = [];
  const bodyHeights = pages.map((page) =>
    median(page.lines.map((line) => line.h))
  );
  for (let p = 0; p < pages.length; p++) {
    const lines = pages[p]!.lines;
    if (lines.length === 0) continue;
    const bodyHeight = bodyHeights[p] || 11;
    let run: string[] = [];
    const flushRun = () => {
      if (run.length === 0) return;
      for (const para of unwrapPdfLines(run)) {
        const text = para.replace(/\s+/g, " ").trim();
        if (text) blocks.push({ kind: "para", text, source: { page: p } });
      }
      run = [];
    };
    for (const line of lines) {
      const text = line.text.trim();
      if (!text) continue;
      if (looksLikeHeading(text, line.h > bodyHeight * HEADING_HEIGHT_RATIO)) {
        flushRun();
        blocks.push({ kind: "heading", level: 1, text, source: { page: p } });
        continue;
      }
      run.push(text);
    }
    flushRun();
  }
  return blocks;
}

/**
 * The block a PDF outline destination starts at.
 *
 * `pageIndex` is 0-based, matching `source.page`. Several outline entries can
 * share a page (arXiv puts Introduction, Background, and Model Architecture on
 * page 2), so the title is looked for among that page's heading blocks first;
 * the page's first block is the fallback.
 */
export function blockForPdfPage(
  blocks: BookBlock[],
  pageIndex: number,
  title = ""
): number {
  const first = blocks.findIndex((block) => block.source?.page === pageIndex);
  if (first < 0) {
    // A destination can point past the last page with text (a blank closing
    // page); snap to the last block rather than dropping the marker.
    return blocks.length > 0 ? blocks.length - 1 : -1;
  }
  const found = headingOnPage(blocks, first, title);
  return found >= 0 ? found : first;
}

/**
 * Two-column pages produce a heading line made of both columns' headings
 * ("Scaled Dot-Product Attention Multi-Head Attention"). The outline names them
 * separately, so a marker is matched to the printed line by substring rather
 * than equality.
 */
function headingOnPage(blocks: BookBlock[], first: number, title: string): number {
  const wanted = normaliseTitle(title);
  if (!wanted) return -1;
  const page = blocks[first]?.source?.page;
  for (let i = first; i < blocks.length && blocks[i]!.source?.page === page; i++) {
    const block = blocks[i]!;
    if (block.kind !== "heading") continue;
    const printed = normaliseTitle(block.text);
    if (printed === wanted || printed.includes(wanted)) return i;
  }
  return -1;
}

function normaliseTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/^[\d.]+\s*/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
