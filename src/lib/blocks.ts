/**
 * The canonical block model.
 *
 * A structured source (EPUB, HTML, PDF, DOCX) already knows where its headings
 * are. Reducing it to one flat string and then re-finding those headings with
 * regexes is what produced the corpus failures: prose mistaken for a heading,
 * contents rows kept as chapters, a body heading glued to the line below it.
 *
 * So each structured extractor returns an ordered block list instead. Chapter
 * markers point at **block indexes**; character offsets are derived once, when
 * the speakable text is produced (`speakableFromBlocks`). Plain text has no
 * blocks, and keeps the heading-line heuristics.
 */

export type BlockKind =
  | "heading"
  | "para"
  | "list-item"
  | "quote"
  | "verse"
  | "table"
  | "caption"
  | "footnote"
  | "scene-break";

export type BlockSource = {
  /** PDF page index (0-based). */
  page?: number;
  /** EPUB spine index (0-based). */
  spine?: number;
  /** HTML element id, used to resolve `href#fragment` TOC targets. */
  id?: string;
};

export type BookBlock = {
  kind: BlockKind;
  /** Heading depth, 1–6. Only set when `kind === "heading"`. */
  level?: number;
  /** One paragraph of source text. No blank lines inside. */
  text: string;
  source?: BlockSource;
};

/** Blocks that can open a chapter. */
export function isHeadingBlock(block: BookBlock | undefined): boolean {
  return block?.kind === "heading";
}

/** Heading depth, clamped to 1–6. */
export function headingLevel(block: BookBlock): number {
  const level = block.level ?? 1;
  if (!Number.isFinite(level)) return 1;
  return Math.min(6, Math.max(1, Math.round(level)));
}

/** True when the block carries no speakable words. */
export function isEmptyBlock(block: BookBlock): boolean {
  return !block.text.trim();
}

/**
 * The heading blocks, in order, with their position in the block list. This is
 * the fallback outline for a structured source whose own TOC is missing or
 * unusable — it is still structural (the parser said "heading"), never a
 * guess at prose shape.
 */
export function headingBlocks(
  blocks: BookBlock[]
): { blockIndex: number; title: string; level: number }[] {
  const out: { blockIndex: number; title: string; level: number }[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.kind !== "heading") continue;
    const title = block.text.replace(/\s+/g, " ").trim();
    if (!title) continue;
    out.push({ blockIndex: i, title, level: headingLevel(block) });
  }
  return out;
}

/**
 * Labels that open a page of book furniture rather than a part of the book.
 *
 * This only filters *chapter markers*. The words stay in the narration unless
 * the extractor drops them, so nothing here can silently delete prose.
 */
const JUNK_HEADING_RE = new RegExp(
  [
    String.raw`^(?:cover|front ?cover|back ?cover)$`,
    String.raw`^(?:the )?title ?page$`,
    String.raw`^(?:half ?title(?: page)?|halftitlepage)$`,
    String.raw`^(?:table of )?contents$`,
    String.raw`^(?:toc|nav)$`,
    String.raw`^(?:copyright|licen[cs]e|licensing|legal notice|rights)$`,
    String.raw`^(?:imprint|colophon|uncopyright|about this edition)$`,
    String.raw`^(?:project gutenberg|the project gutenberg ebook|gutenberg)$`,
    String.raw`^(?:transcriber'?s? notes?|editor'?s? notes?)\b`,
    String.raw`^\*{3}\s*(?:start|end) of\b`,
    String.raw`^(?:start|end) of (?:the )?project gutenberg\b`,
  ].join("|"),
  "i"
);

/**
 * True when a heading names book furniture rather than a part of the book.
 * A book's own contents page is a list of chapters, not a chapter.
 */
export function isFurnitureHeading(title: string): boolean {
  const t = title.replace(/\s+/g, " ").trim();
  if (!t) return true;
  if (t.length > 120) return false;
  return JUNK_HEADING_RE.test(t);
}

/** Project Gutenberg's own boilerplate, which is not part of the book. */
const PG_START_RE = /^\*{3}\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*{3}\s*$/i;
const PG_END_RE = /^\*{3}\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*{3}\s*$/i;

/**
 * Remove the Project Gutenberg header and footer from a block list.
 *
 * The header is everything up to and including the START banner; the footer is
 * the END banner and everything after it (the licence, which used to be
 * detected as five "chapters" of legal boilerplate in Sherlock Holmes).
 * A file with no banner is returned unchanged.
 */
export function stripGutenbergBlocks(blocks: BookBlock[]): BookBlock[] {
  let start = -1;
  let end = blocks.length;
  for (let i = 0; i < blocks.length; i++) {
    const text = blocks[i]!.text.trim();
    if (start < 0 && PG_START_RE.test(text)) {
      start = i;
      continue;
    }
    if (PG_END_RE.test(text)) {
      end = i;
      break;
    }
  }
  if (start < 0 && end === blocks.length) return blocks;
  return blocks.slice(start + 1, end);
}

/** The same rule for a flat string, applied line by line. */
export function stripGutenbergFurniture(text: string): string {
  const lines = text.split("\n");
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (start < 0 && PG_START_RE.test(line)) {
      start = i;
      continue;
    }
    if (PG_END_RE.test(line)) {
      end = i;
      break;
    }
  }
  if (start < 0 && end === lines.length) return text;
  return lines.slice(start + 1, end).join("\n").trim();
}
