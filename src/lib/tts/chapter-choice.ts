/**
 * The chapter-resolution entry point used by every intake path.
 *
 * The structure comes from the source (EPUB nav, PDF outline, HTML headings) or
 * from the plain-text heuristics, and `resolveChapters` is the one that decides.
 * This module adds the two things a caller needs on top:
 *
 * - **the optional local classifier** for borderline plain-text heading lines,
 *   behind `CHAPTER_CLASSIFIER=1`;
 * - **a validity check**, so a garbage outline can be rejected by a caller that
 *   would otherwise store it.
 *
 * An optional OpenRouter verifier (`CHAPTER_LLM=1`) may label mid-score layout
 * lines after the deterministic pass. It does not write titles, and a reply
 * that drops high-confidence headings is discarded. The old detector that
 * replaced a 65-chapter outline with one chapter is not this call.
 */

import {
  type BookChapter,
  type ChapterHint,
  type ChaptersDocument,
  resolveChapters,
  resolveChaptersWithClassifier,
} from "@/lib/book-chapters";
import { maybeVerifyChapters } from "@/lib/chapter-llm";
import { classifierEnabled } from "@/lib/chapter-classifier";
import type { ExtractHost } from "@/lib/uploads/extract-route";

/** A nonempty outline with ordered, in-range tree boundaries. */
export function hasValidChapterStructure(spoken: string, doc: ChaptersDocument): boolean {
  if (
    ![
      "epub-spine",
      "pdf-outline",
      "printed-toc",
      "docx-heading",
      "html-heading",
      "heading-lines",
      "layout",
      "sections",
    ].includes(doc.source)
  ) {
    return false;
  }
  const visit = (nodes: BookChapter[], from: number, end: number): boolean => {
    let previous = from - 1;
    return nodes.every((node, i) => {
      const next = nodes[i + 1]?.charStart ?? end;
      if (
        !node.title.trim() ||
        !Number.isInteger(node.charStart) ||
        node.charStart < from ||
        node.charStart <= previous ||
        node.charStart >= end ||
        !Number.isInteger(node.charEnd) ||
        node.charEnd <= node.charStart ||
        node.charEnd > spoken.length
      ) {
        return false;
      }
      previous = node.charStart;
      return visit(node.children ?? [], node.charStart, next);
    });
  };
  return doc.chapters.length > 0 && visit(doc.chapters, 0, spoken.length);
}

/**
 * Resolve the outline for a book.
 *
 * `host` is only used to decide whether the optional classifier may run on this
 * machine: it is a CPU model, so Vercel and the Cloudflare fallback skip it.
 */
export async function resolveChaptersForBook(
  spoken: string,
  hint: ChapterHint,
  opts?: { host?: ExtractHost }
): Promise<ChaptersDocument> {
  const sync = resolveChapters(spoken, hint);
  const verified = await maybeVerifyChapters(spoken, hint, sync).catch(() => sync);
  if (!classifierEnabled()) return verified;
  if (opts?.host !== "node") return verified;
  // The classifier only rewrites heading-line books. A layout outline stays.
  if (verified.source !== "heading-lines") return verified;
  const refined = await resolveChaptersWithClassifier(spoken, hint).catch(() => null);
  return refined?.doc ?? verified;
}
