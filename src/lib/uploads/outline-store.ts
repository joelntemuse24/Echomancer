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
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as { version?: unknown; hint?: unknown };
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

  return {
    source: source as ChapterSource,
    titles,
    ...(isNumberArray(h.pageStarts) ? { pageStarts: h.pageStarts } : {}),
    ...(isStringArray(h.tocLines) ? { tocLines: h.tocLines } : {}),
    ...(isStringArray(h.pageProbes) ? { pageProbes: h.pageProbes } : {}),
  };
}
