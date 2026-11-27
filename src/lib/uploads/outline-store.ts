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
import type { LayoutFeatures, LayoutLine } from "@/lib/chapter-layout";

export const OUTLINE_JSON_NAME = "outline.json";
export const OUTLINE_VERSION = 1;

const SOURCES: readonly ChapterSource[] = [
  "heading-lines",
  "layout",
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

  const parsedHint: ChapterHint = {
    source: source as ChapterSource,
    titles,
    ...(isNumberArray(h.pageStarts) ? { pageStarts: h.pageStarts } : {}),
    ...(isStringArray(h.tocLines) ? { tocLines: h.tocLines } : {}),
    ...(isStringArray(h.pageProbes) ? { pageProbes: h.pageProbes } : {}),
  };
  const layout = parseLayout(h.layout);
  if (layout) parsedHint.layout = layout;
  return parsedHint;
}

function parseLayout(value: unknown): LayoutFeatures | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.bodySize !== "number" || typeof record.pageCount !== "number") return undefined;
  if (!Array.isArray(record.lines)) return undefined;
  const lines: LayoutLine[] = [];
  for (const row of record.lines) {
    if (!row || typeof row !== "object") continue;
    const line = row as Record<string, unknown>;
    if (typeof line.text !== "string" || typeof line.page !== "number" || typeof line.size !== "number") {
      continue;
    }
    lines.push({
      text: line.text,
      page: line.page,
      size: line.size,
      y: typeof line.y === "number" ? line.y : 0,
      ...(line.bold === true ? { bold: true } : {}),
      ...(line.centered === true ? { centered: true } : {}),
      ...(typeof line.gapAbove === "number" ? { gapAbove: line.gapAbove } : {}),
      ...(line.first === true ? { first: true } : {}),
      ...(typeof line.context === "string" ? { context: line.context } : {}),
    });
    if (lines.length >= 4000) break;
  }
  if (lines.length === 0) return undefined;
  return { bodySize: record.bodySize, pageCount: record.pageCount, lines };
}
