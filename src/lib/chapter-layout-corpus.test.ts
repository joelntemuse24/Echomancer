/**
 * Corpus regression. The previous resolver is `resolveChapters` with no layout
 * features. A trusted outline must come back unchanged. A heading-line book
 * must not lose a labelled chapter (Chapter, Part, Article, or a numbered
 * heading) when layout features are present.
 *
 * Skips when the corpus has not been fetched. `scripts/fetch-corpus.sh`
 * downloads it; nothing in it is committed.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveChapters, type BookChapter, type ChapterHint } from "@/lib/book-chapters";

const CORPUS = process.env.CORPUS_DIR || "/tmp/echomancer-corpus";
const MANIFEST = join(process.cwd(), "scripts", "corpus-manifest.tsv");

const LABELLED =
  /^(?:chapter|part|book|volume|article|amendment|section)\s+\S|^(?:\d{1,3}|[A-H])(?:\.\d{1,2}){0,3}\s+\p{L}/iu;

function titles(nodes: BookChapter[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    out.push(node.title);
    if (node.children?.length) out.push(...titles(node.children));
  }
  return out;
}

function labelled(nodes: BookChapter[]): string[] {
  return titles(nodes).filter((title) => LABELLED.test(title.trim()));
}

describe("chapter corpus does not get worse", () => {
  const present = existsSync(CORPUS) && existsSync(MANIFEST);
  it.skipIf(!present)("corpus is fetched", () => {
    expect(present).toBe(true);
  });

  it.skipIf(!present)(
    "keeps trusted outlines and labelled heading-line chapters",
    async () => {
      const { extractDocument } = await import("@/lib/text-extraction");
      const { toSpeakableText } = await import("@/lib/tts/speakable-text");
      const { normalizeSourceText } = await import("@/lib/source-text");
      const rows = readFileSync(MANIFEST, "utf8")
        .split("\n")
        .map((line) => line.split("\t"))
        .filter((cols) => cols[0] && !cols[0].startsWith("#") && cols[1]);
      for (const [id, format] of rows) {
        const path = join(CORPUS, `${id}.${format}`);
        if (!existsSync(path) || statSync(path).size < 2000) continue;
        const bytes = readFileSync(path);
        let hint: ChapterHint;
        let text: string;
        if (format === "html") {
          const { htmlToArticleBlocks } = await import("@/lib/html-article");
          const { locateBlockStarts } = await import("@/lib/block-projection");
          const article = htmlToArticleBlocks(bytes.toString("utf8"));
          text = normalizeSourceText(article.text);
          hint = {
            source: "html-heading",
            titles: [],
            blocks: article.blocks,
            blockStart: locateBlockStarts(text, article.blocks),
          };
        } else {
          const extracted = await extractDocument(bytes, `${id}.${format}`);
          text = extracted.text;
          hint = {
            ...extracted.hint,
            ...(extracted.blocks ? { blocks: extracted.blocks } : {}),
            ...(extracted.blockStart ? { blockStart: extracted.blockStart } : {}),
            ...(extracted.outline ? { blockOutline: extracted.outline } : {}),
          };
        }
        const spoken = toSpeakableText(text, { normalizeTitles: false });
        const before = resolveChapters(spoken, { ...hint, layout: undefined });
        const after = resolveChapters(spoken, hint);
        const trusted = ["epub-spine", "pdf-outline", "docx-heading", "html-heading", "printed-toc", "sections"];
        if (trusted.includes(before.source)) {
          expect(after.source, id).toBe(before.source);
          expect(titles(after.chapters), id).toEqual(titles(before.chapters));
          continue;
        }
        const lost = labelled(before.chapters).filter(
          (title) => !titles(after.chapters).includes(title)
        );
        expect(lost, id).toEqual([]);
      }
    },
    900_000
  );
});
