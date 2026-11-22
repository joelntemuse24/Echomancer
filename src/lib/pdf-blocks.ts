/**
 * PDF → blocks.
 *
 * `pdf-furniture.ts` groups pdf.js items into visual lines and marks running
 * heads and page numbers. `pdf-line-unwrap.ts` then decides the paragraphs that
 * become the narration string.
 *
 * This module classifies the *same* decided paragraphs: a paragraph whose lines
 * all read as headings is a heading block, everything else is a paragraph block.
 * There is no second text pipeline, so a block's text is a substring of
 * `content.txt` by construction and its offset is a slice, not a search. An
 * earlier version re-unwrapped each page independently and dropped furniture on
 * its own; the two readers then disagreed on almost every block (Pro Git: 9 of
 * 1260 blocks could be located), which is why an outline destination could land
 * on the wrong page's text.
 *
 * The blocks exist so an embedded outline can name a *block* instead of a page
 * offset that has to be re-found in the prose.
 */

import type { BookBlock } from "@/lib/blocks";
import type { PdfParagraph } from "@/lib/pdf-line-unwrap";
import { isLayoutHeadingLine, isSpeakableHeading } from "@/lib/tts/speakable-text";

/**
 * A heading, from the extractor's own evidence: a heading shape.
 *
 * Deliberately conservative. A PDF has no markup to say which line is a title,
 * so guessing produces table rows and figure labels as chapters — which is
 * exactly what the corpus showed when a bare-title rule was tried here. The
 * embedded outline is the reliable answer for a PDF; this is only its fallback.
 */
function looksLikeHeading(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (isLayoutHeadingLine(t) || isSpeakableHeading(t)) return true;
  if (t.length > 80) return false;
  return false;
}

/**
 * Turn decided paragraphs into blocks.
 *
 * A paragraph is a heading when its whole text reads as a title. The page it
 * starts on comes from the same unwrap pass, so an outline destination resolves
 * to a real block rather than to a line range this module re-derived.
 */
export function pdfBlocksFromParagraphs(paras: PdfParagraph[]): BookBlock[] {
  const blocks: BookBlock[] = [];
  for (const para of paras) {
    const text = para.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const heading = looksLikeHeading(text);
    blocks.push({
      kind: heading ? "heading" : "para",
      ...(heading ? { level: 1 } : {}),
      text,
      source: { page: para.page },
    });
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
