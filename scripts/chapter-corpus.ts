/**
 * Chapter-detection corpus runner.
 *
 * Runs every corpus source through the *real* intake for its format — the same
 * `extractDocument` / `htmlToArticle` / `readPublicUrl` code paths the product
 * uses — then reports what chapter detection made of it.
 *
 *   ./scripts/fetch-corpus.sh
 *   npx tsx --tsconfig tsconfig.json scripts/chapter-corpus.ts
 *   npx tsx --tsconfig tsconfig.json scripts/chapter-corpus.ts --only pg-moby-dick
 *   npx tsx --tsconfig tsconfig.json scripts/chapter-corpus.ts --json > results.json
 *
 * Nothing here asserts. It prints a table plus a list of things that look
 * wrong, so a human can judge; the checked-in regression tests live in
 * `src/lib/tts/speakable-text.test.ts` and friends.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const CORPUS = process.env.CORPUS_DIR || "/tmp/corpus";
const MANIFEST = join(process.cwd(), "scripts", "corpus-manifest.tsv");

type Row = {
  id: string;
  format: "txt" | "epub" | "pdf" | "html";
  note: string;
};

type Result = {
  id: string;
  format: string;
  chars: number;
  source: string;
  /** Top-level markers (what the player shows as a tree's roots). */
  chapters: number;
  /** Every marker, children included — the honest size of the outline. */
  total: number;
  ordered: boolean;
  first: string[];
  last: string[];
  warnings: string[];
  ms: number;
};

/** Every marker, children included. */
function countNodes(nodes: { children?: unknown[] }[]): number {
  return nodes.reduce(
    (sum, node) =>
      sum + 1 + countNodes((node.children ?? []) as { children?: unknown[] }[]),
    0
  );
}

/** Flatten to document order so ordering and duplicates cover the whole tree. */
function flattenTitles(nodes: { title: string; children?: unknown[] }[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    out.push(node.title);
    out.push(...flattenTitles((node.children ?? []) as typeof nodes));
  }
  return out;
}

function manifest(): Row[] {
  const raw = readFileSync(MANIFEST, "utf8");
  const rows: Row[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [id, format, , note] = line.split("\t");
    if (!id || !format) continue;
    rows.push({
      id: id.trim(),
      format: format.trim() as Row["format"],
      note: (note ?? "").trim(),
    });
  }
  return rows;
}

/** Heuristics that flag a chapter list worth a human look. */
function inspect(titles: string[], ordered: boolean): string[] {
  const out: string[] = [];
  if (!ordered) out.push("OUT_OF_ORDER");
  if (titles.length === 0) out.push("NO_CHAPTERS");

  const lower = titles.map((t) => t.toLowerCase().trim());
  const seen = new Set<string>();
  for (const t of lower) {
    if (!t) continue;
    if (seen.has(t)) {
      out.push(`DUPLICATE:${t.slice(0, 30)}`);
      break;
    }
    seen.add(t);
  }

  // Front matter that should not be a chapter.
  const frontMatter =
    /^(?:contents|table of contents|by |copyright|isbn|published|publisher|printed|edition|volume \d+\.\d+|librar|university press|press,)|(?:publisher|road|street|london|new york|charing|cross)\b/i;
  const frontHits = titles.slice(0, 4).filter((t) => frontMatter.test(t.trim()));
  if (frontHits.length > 0) out.push(`FRONT_MATTER:${frontHits[0]!.slice(0, 30)}`);

  // A contents row: "Chapter N ..... 12" or "Title 12".
  const contentsRows = titles.filter((t) => /(?:\.{3,}|\s{2,}\d{1,4}$|\d{1,4}$)/.test(t) && t.length < 80);
  if (contentsRows.length > 0 && contentsRows.length >= Math.max(3, titles.length * 0.2)) {
    out.push(`CONTENTS_ROWS:${contentsRows.length}`);
  }

  // A merged chapter: one title swallowing the next ("CHAPTER 1. X CHAPTER 2.").
  const merged = titles.filter((t) => (t.match(/\b(?:chapter|part|section)\b/gi) ?? []).length >= 2);
  if (merged.length > 0) out.push(`MERGED:${merged[0]!.slice(0, 34)}`);

  // One giant chapter covering a normal-size book.
  if (titles.length === 1) out.push("SINGLE_CHAPTER");
  return out;
}

async function run(row: Row): Promise<Result | { id: string; error: string }> {
  const path = join(CORPUS, `${row.id}.${row.format}`);
  if (!existsSync(path)) return { id: row.id, error: "missing (run scripts/fetch-corpus.sh)" };

  const started = Date.now();
  const bytes = readFileSync(path);
  const { toSpeakableText } = await import("@/lib/tts/speakable-text");
  const { safeResolveChapters } = await import("@/lib/book-chapters");
  const { normalizeSourceText } = await import("@/lib/source-text");

  let text: string;
  let hint: {
    source: string;
    titles: unknown[];
    blocks?: unknown[];
    blockStart?: number[];
    blockOutline?: unknown[];
  } = {
    source: "heading-lines",
    titles: [],
  };

  if (row.format === "html") {
    // Same extraction the URL intake uses, blocks and all: the page's own
    // `<h1>`–`<h6>` are its chapter markers.
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
    // TXT / EPUB / PDF all go through the real document extractor.
    const { extractDocument } = await import("@/lib/text-extraction");
    const extracted = await extractDocument(bytes, `${row.id}.${row.format}`);
    text = extracted.text;
    hint = {
      ...(extracted.hint as typeof hint),
      ...(extracted.blocks ? { blocks: extracted.blocks } : {}),
      ...(extracted.blockStart ? { blockStart: extracted.blockStart } : {}),
      ...(extracted.outline ? { blockOutline: extracted.outline } : {}),
    };
  }

  const spoken = toSpeakableText(text, { normalizeTitles: false });
  const doc = safeResolveChapters(spoken, hint as never);
  // Ordering and duplicates are checked over the whole tree: a nested part
  // list can still be out of order or repeat a label inside a container.
  const titles = flattenTitles(doc.chapters);
  const starts = doc.chapters.flatMap((chapter) => [chapter.charStart]);
  const ordered = starts.every((start, i) => i === 0 || start > starts[i - 1]!);

  return {
    id: row.id,
    format: row.format,
    chars: spoken.length,
    source: doc.source,
    chapters: doc.chapters.length,
    total: countNodes(doc.chapters),
    ordered,
    first: titles.slice(0, 3),
    last: titles.slice(-2),
    warnings: inspect(titles, ordered),
    ms: Date.now() - started,
  };
}

async function main() {
  const onlyAt = process.argv.indexOf("--only");
  const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : null;
  const asJson = process.argv.includes("--json");
  const rows = manifest().filter((r) => !only || r.id === only);
  if (rows.length === 0) {
    console.error(`no corpus entries${only ? ` matching "${only}"` : ""}`);
    process.exit(1);
  }

  const results: Result[] = [];
  const failures: { id: string; error: string }[] = [];
  for (const row of rows) {
    try {
      const result = await run(row);
      if ("error" in result) failures.push(result);
      else results.push(result);
    } catch (err) {
      failures.push({ id: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ results, failures }, null, 2));
    return;
  }

  console.log(
    ["id".padEnd(28), "fmt".padEnd(5), "chars".padStart(8), "src".padEnd(14), "roots".padStart(5), "all".padStart(4), "ord".padStart(4), "ms".padStart(7)].join(" ")
  );
  console.log("-".repeat(78));
  for (const r of results) {
    console.log(
      [
        r.id.padEnd(28),
        r.format.padEnd(5),
        String(r.chars).padStart(8),
        r.source.padEnd(14),
        String(r.chapters).padStart(5),
        String(r.total).padStart(4),
        (r.ordered ? "yes" : "NO").padStart(4),
        String(r.ms).padStart(7),
      ].join(" ")
    );
  }

  console.log("\nFirst / last entries:");
  for (const r of results) {
    console.log(`  ${r.id}`);
    console.log(`     first: ${JSON.stringify(r.first)}`);
    console.log(`     last:  ${JSON.stringify(r.last)}`);
  }

  const flagged = results.filter((r) => r.warnings.length > 0);
  console.log(`\nFlagged (${flagged.length}/${results.length}):`);
  for (const r of flagged) console.log(`  ${r.id.padEnd(28)} ${r.warnings.join(" ")}`);
  if (flagged.length === 0) console.log("  none");

  if (failures.length) {
    console.log(`\nFailed to run (${failures.length}):`);
    for (const f of failures) console.log(`  ${f.id.padEnd(28)} ${f.error}`);
  }
}

void main();
