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
 * There is no model call here any more. The OpenRouter chapter detector, the
 * embedding topic placer, and the candidate-index chooser all existed to guess
 * structure that the source already had — and the corpus showed them replacing a
 * correct 65-chapter outline with a 1-chapter one. A book with no markers now
 * gets labelled length parts instead.
 */

import {
  type BookChapter,
  type ChapterHint,
  type ChaptersDocument,
  resolveChapters,
  resolveChaptersWithClassifier,
} from "@/lib/book-chapters";
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
  if (!classifierEnabled()) return sync;
  if (opts?.host !== "node") return sync;
  const refined = await resolveChaptersWithClassifier(spoken, hint).catch(() => null);
  return refined?.doc ?? sync;
}
