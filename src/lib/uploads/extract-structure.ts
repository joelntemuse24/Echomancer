/**
 * Attach a document's own structure to the text that will actually be stored.
 *
 * Every structured extractor (`text-extraction.ts`) already returns the pieces a
 * chapter list needs: an ordered block list, a TOC resolved to block indexes,
 * and for a PDF the page each block starts on. `resolveChapters` can then place
 * chapters by block instead of re-finding titles in the prose — but only if the
 * offsets are for the string that was stored.
 *
 * Both rewrites below happen *here*, once, against that one string:
 *
 * - `blockStart` is re-located, because `speakableFromBlocks` measured it against
 *   the normalized text and `toSpeakableText` moves words again.
 * - `pageStarts` is re-anchored, because it indexes the unwrapped text.
 *
 * Re-locating the same array twice is not idempotent: the second pass searches
 * from an offset that already belongs to the new string.
 *
 * `blocks` is passed through only when enough of them could be located. A PDF
 * block comes from the page's lines and the narration string from the same lines
 * unwrapped, so the two agree except where cleanup rewrote a paragraph; below the
 * threshold the block list would place chapters in the wrong place, and the
 * page-and-probe path (`alignTitles`) is the better evidence.
 */

import type { BookBlock } from "@/lib/blocks";
import type { ChapterHint } from "@/lib/book-chapters";
import { locateBlockStarts } from "@/lib/block-projection";
import { relocatePageStarts } from "@/lib/page-offsets";

/**
 * Share of blocks that must be findable in the stored text before the block
 * outline is trusted. EPUB locates ~1.00 and DOCX/HTML are structural, so they
 * clear it comfortably; a PDF that cleanup rewrote lands near 0.65.
 */
export const MIN_BLOCK_LOCATE_RATE = 0.9;

/** Offsets re-measured against `text`, plus the blocks when they are reliable. */
export function structureForText(
  hint: ChapterHint,
  text: string,
  blocks?: BookBlock[]
): ChapterHint {
  const next: ChapterHint = { ...hint };

  if (next.pageProbes?.length && next.pageStarts?.length) {
    next.pageStarts = relocatePageStarts(text, next.pageProbes, next.pageStarts);
  }

  const outline = next.blockOutline?.length ? next.blockOutline : undefined;
  if (!blocks?.length || !outline) {
    // Markers without blocks cannot be resolved, and leaving them behind would
    // look like a wired outline to any later reader.
    delete next.blockOutline;
    return next;
  }

  const starts = locateBlockStarts(text, blocks);
  const located = starts.filter((offset) => offset >= 0).length;
  if (located / blocks.length < MIN_BLOCK_LOCATE_RATE) {
    delete next.blockOutline;
    return next;
  }

  // A marker whose own block has no words would place the chapter nowhere; drop
  // it so the remaining markers stay usable.
  const usable = outline.filter((entry) => (starts[entry.blockIndex] ?? -1) >= 0);
  if (usable.length < 2) return next;

  return { ...next, blocks, blockStart: starts, blockOutline: usable };
}

/** True when a hint is detailed enough to re-align chapters without the source. */
export function hasStructuralHint(hint: ChapterHint): boolean {
  return Boolean(
    hint.blockOutline?.length || hint.titles.length > 0 || hint.tocLines?.length
  );
}
