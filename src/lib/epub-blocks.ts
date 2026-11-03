/**
 * EPUB → blocks, and the TOC mapped onto them.
 *
 * An EPUB is the best-structured source we accept: it ships a nav document or
 * an NCX whose entries point at a spine file (and usually a fragment). That
 * TOC is the book's own chapter list, so it is read first and mapped to the
 * block each entry starts at.
 *
 * Two things the old path got wrong:
 *
 * - Headings were re-derived from prose after the HTML was flattened, so a
 *   chapter title the book marked up as an `<h2>` could be merged into the
 *   paragraph below it and lost.
 * - `href#fragment` resolved to the first paragraph of the whole spine file,
 *   so chapters sharing one file all aligned to the same place.
 */

import type { BookBlock } from "@/lib/blocks";
import { htmlRegionToBlocks } from "@/lib/html-blocks";
import { normalizeEpubHref, stripEpubFurniture } from "@/lib/epub-html";
import { trimTrailingChapterLabel } from "@/lib/block-chapters";

export type EpubTocEntry = { label: string; href: string; level: number };

export type EpubSpineDoc = {
  /** Path inside the container, relative to the OPF directory. */
  path: string;
  html: string;
};

/** Blocks for one spine document, each tagged with its spine index and anchors. */
export function spineDocBlocks(doc: EpubSpineDoc, spineIndex: number): BookBlock[] {
  const blocks = htmlRegionToBlocks(stripEpubFurniture(doc.html));
  for (const block of blocks) {
    block.source = { ...(block.source ?? {}), spine: spineIndex };
  }
  return joinOrdinalHeadings(blocks);
}

/**
 * "I" followed by "Loomings" is one chapter title, not a heading plus a stray
 * paragraph. A heading that is only an ordinal adopts the short title
 * paragraph directly under it — the shape `<hgroup>` produces, which is how
 * Standard Ebooks prints "I / Loomings".
 */
function joinOrdinalHeadings(blocks: BookBlock[]): BookBlock[] {
  const out: BookBlock[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const next = blocks[i + 1];
    if (
      block.kind === "heading" &&
      next?.kind === "para" &&
      isOrdinalHeading(block.text) &&
      isTitleLine(next.text)
    ) {
      out.push({ ...block, text: `${block.text.trim()} ${next.text.trim()}` });
      i += 1;
      continue;
    }
    out.push(block);
  }
  return out;
}

const ORDINAL_RE = /^(?:\d{1,3}|[IVXLCDM]{1,12})\.?$/i;

function isOrdinalHeading(text: string): boolean {
  return ORDINAL_RE.test(text.trim());
}

/** A short title-case line with no sentence punctuation. */
function isTitleLine(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 90) return false;
  if (t.split(/\s+/).length > 12) return false;
  if (/[.!?]["”’]?$/u.test(t) && t.split(/\s+/).length > 4) return false;
  return /\p{L}/u.test(t);
}

export type EpubAssembly = {
  blocks: BookBlock[];
  /** TOC entries resolved to the block each one starts at. */
  outline: { title: string; level: number; blockIndex: number }[];
};

/**
 * Join the spine into one block list, then map the TOC onto it.
 *
 * A TOC entry resolves to the block carrying its `#fragment` id when that id
 * is present, else to the first block of the spine file it names. An entry
 * that names a file we did not read (a cover, the nav page itself) is dropped.
 */
export function assembleEpub(docs: EpubSpineDoc[], toc: EpubTocEntry[]): EpubAssembly {
  const blocks: BookBlock[] = [];
  const ranges: { path: string; firstBlock: number; blockCount: number }[] = [];
  const byPath = new Map<string, { firstBlock: number; blockCount: number }>();
  for (let spine = 0; spine < docs.length; spine++) {
    const doc = docs[spine]!;
    const first = blocks.length;
    const docBlocks = spineDocBlocks(doc, spine);
    blocks.push(...docBlocks);
    const range = { path: doc.path, firstBlock: first, blockCount: docBlocks.length };
    ranges.push(range);
    if (!byPath.has(doc.path)) byPath.set(doc.path, range);
  }

  const outline: EpubAssembly["outline"] = [];
  for (const entry of toc) {
    const title = trimTrailingChapterLabel(entry.label);
    if (!title || title.length > 160) continue;
    const path = normalizeEpubHref("", entry.href.split("#")[0] ?? "");
    if (!path) continue;
    const range = byPath.get(path);
    if (!range || range.blockCount === 0) continue;
    const blockIndex = fragmentBlock(entry.href, range, blocks);
    if (blockIndex < 0) continue;
    outline.push({ title, level: Math.max(1, entry.level), blockIndex });
  }
  return { blocks, outline };
}

function fragmentBlock(
  href: string,
  range: { firstBlock: number; blockCount: number },
  blocks: BookBlock[]
): number {
  const hash = href.indexOf("#");
  if (hash >= 0) {
    const raw = href.slice(hash + 1);
    if (raw) {
      let id = raw;
      try {
        id = decodeURIComponent(raw);
      } catch {
        id = raw;
      }
      for (let i = range.firstBlock; i < range.firstBlock + range.blockCount; i++) {
        if (blocks[i]?.source?.id === id) return i;
      }
    }
  }
  return range.firstBlock;
}
