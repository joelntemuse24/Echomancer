/**
 * The extraction-time chapter hint, persisted next to `content.txt`.
 *
 * `extractDocument` produces a rich hint — PDF outline titles with page
 * indexes, exact page offsets, EPUB anchors, printed-TOC lines — and it used
 * to die at the end of `runUploadExtract`. Anything that re-aligns chapters
 * later (freeze, `rechapter-takehome`) had to re-parse the source file to get
 * it back.
 *
 * `outline.json` keeps it. It is advisory: `chapters.json` stays the resolved
 * outline that the player reads, and a missing or unparsable `outline.json`
 * falls back to the old behaviour.
 */

import type { BookBlock } from "@/lib/blocks";
import type { ChapterHint, ChapterSource } from "@/lib/book-chapters";

export const OUTLINE_JSON_NAME = "outline.json";
export const OUTLINE_VERSION = 1;

const SOURCES: readonly ChapterSource[] = [
  "heading-lines",
  "pdf-outline",
  "epub-spine",
  "docx-heading",
  "html-heading",
  "printed-toc",
  "ai",
  "sections",
  "none",
];

export interface StoredOutline {
  version: typeof OUTLINE_VERSION;
  hint: ChapterHint;
  /**
   * The source's block list, when the hint's `blockOutline` points into it.
   * Without this a re-align has markers but no blocks to resolve, so it has to
   * re-parse the source file. Advisory, like the hint itself.
   */
  blocks?: BookBlock[];
}

export function outlineObjectKey(uploadId: string): string {
  return `pdfs/${uploadId}/${OUTLINE_JSON_NAME}`;
}

function isNumberArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((s) => typeof s === "string");
}

/** Narrow untrusted JSON into a hint. Returns null on anything unexpected. */
export function parseOutline(raw: string): ChapterHint | null {
  return parseStoredOutline(raw)?.hint ?? null;
}

/**
 * The stored outline, hint and blocks together.
 *
 * `blocks` is what a block-indexed `blockOutline` points into, and `blockStart`
 * is each block's offset in the stored `content.txt`. Both are optional: an
 * older `outline.json` has neither, and the caller then falls back to the
 * title/page path.
 */
export function parseStoredOutline(raw: string): StoredOutline | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as { version?: unknown; hint?: unknown; blocks?: unknown };
  if (record.version !== OUTLINE_VERSION) return null;
  const hint = record.hint;
  if (!hint || typeof hint !== "object") return null;

  const h = hint as Record<string, unknown>;
  const source = h.source;
  if (typeof source !== "string" || !SOURCES.includes(source as ChapterSource)) {
    return null;
  }
  const titles: ChapterHint["titles"] = [];
  if (Array.isArray(h.titles)) {
    for (const entry of h.titles) {
      if (!entry || typeof entry !== "object") continue;
      const t = entry as Record<string, unknown>;
      if (typeof t.title !== "string" || typeof t.level !== "number") continue;
      titles.push({
        title: t.title,
        level: t.level,
        ...(isStringArray(t.anchors) ? { anchors: t.anchors } : {}),
        ...(typeof t.charStart === "number" ? { charStart: t.charStart } : {}),
        ...(typeof t.pageIndex === "number" ? { pageIndex: t.pageIndex } : {}),
      });
    }
  }

  const outline: ChapterHint["blockOutline"] = [];
  if (Array.isArray(h.blockOutline)) {
    for (const entry of h.blockOutline) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (
        typeof e.title !== "string" ||
        typeof e.level !== "number" ||
        typeof e.blockIndex !== "number"
      ) {
        continue;
      }
      outline.push({ title: e.title, level: e.level, blockIndex: e.blockIndex });
    }
  }

  return {
    version: OUTLINE_VERSION,
    hint: {
      source: source as ChapterSource,
      titles,
      ...(isNumberArray(h.pageStarts) ? { pageStarts: h.pageStarts } : {}),
      ...(isStringArray(h.tocLines) ? { tocLines: h.tocLines } : {}),
      ...(isStringArray(h.pageProbes) ? { pageProbes: h.pageProbes } : {}),
      ...(outline.length > 0 ? { blockOutline: outline } : {}),
      ...(isNumberArray(h.blockStart) ? { blockStart: h.blockStart } : {}),
    },
    ...(isBookBlocks(record.blocks) ? { blocks: record.blocks } : {}),
  };
}

/** Blocks are only kept when every entry has the shape the resolver reads. */
function isBookBlocks(value: unknown): value is BookBlock[] {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const b = entry as Record<string, unknown>;
    if (typeof b.text !== "string") return false;
    if (typeof b.kind !== "string") return false;
    if (b.level !== undefined && typeof b.level !== "number") return false;
    return true;
  });
}
