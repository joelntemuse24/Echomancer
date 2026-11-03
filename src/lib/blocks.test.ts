import { describe, expect, it } from "vitest";
import { htmlRegionToBlocks } from "@/lib/html-blocks";
import { speakableFromBlocks, locateBlockStarts, blocksToSourceText } from "@/lib/block-projection";
import {
  chaptersFromBlockOutline,
  chooseOutline,
  filterTocEntries,
  tocDistinctRatio,
  trimTrailingChapterLabel,
} from "@/lib/block-chapters";
import {
  isFurnitureHeading,
  stripGutenbergFurniture,
  type BookBlock,
} from "@/lib/blocks";

const PROSE =
  "The lamps were lit along the quay before the tide turned, and she closed the ledger.";

const ARTICLE = `<html><head><title>Harbour</title></head><body><article>
<h1>The Quay at Dusk</h1>
<p>${PROSE}</p>
<h2>Working the tide</h2>
<p>They rowed out to the point and waited for the wind to shift. It never did.</p>
<h2>The ledger</h2>
<p>Every entry was written in the same hand, and the ink had faded by spring.</p>
</article></body></html>`;

describe("HTML headings become blocks", () => {
  it("keeps h1-h6 as heading blocks with their level", () => {
    const blocks = htmlRegionToBlocks(ARTICLE);
    const headings = blocks.filter((block) => block.kind === "heading");
    expect(headings.map((block) => [block.level, block.text])).toEqual([
      [1, "The Quay at Dusk"],
      [2, "Working the tide"],
      [2, "The ledger"],
    ]);
    expect(blocks.filter((block) => block.kind === "para")).toHaveLength(3);
  });

  it("drops nav rows, trending rails, and scripts", () => {
    const blocks = htmlRegionToBlocks(`<body>
      <div class="links"><a href="/">Home</a><a href="/b">Blog</a><a href="/a">About</a></div>
      <article><h1>Field note</h1><p>${PROSE}</p></article>
      <div class="trending"><h3>More from the blog</h3><ul><li>Notes on rope</li></ul></div>
      <script>const secret = "supercalifragilistic";</script>
    </body>`);
    const text = blocks.map((block) => block.text).join("\n");
    expect(text).toContain("Field note");
    expect(text).toContain(PROSE);
    expect(text).not.toContain("More from the blog");
    expect(text).not.toContain("supercalifragilistic");
  });

  it("reads a table row as a comma list and keeps a layout table's paragraphs", () => {
    const table = htmlRegionToBlocks(
      `<table><tr><th>Name</th><th>Year</th></tr><tr><td>Moby-Dick</td><td>1851</td></tr></table>`
    );
    expect(table.filter((block) => block.kind === "table").map((block) => block.text)).toEqual([
      "Name, Year",
      "Moby-Dick, 1851",
    ]);
    const layout = htmlRegionToBlocks(
      `<table><tr><td><p>${PROSE}</p><p>Second paragraph of body text.</p></td></tr></table>`
    );
    expect(layout.every((block) => block.kind === "para")).toBe(true);
  });
});

describe("block projection", () => {
  const blocks: BookBlock[] = [
    { kind: "heading", level: 1, text: "Chapter One" },
    { kind: "para", text: PROSE },
    { kind: "heading", level: 1, text: "Chapter Two" },
    { kind: "para", text: "Night settled over the harbour and the boats were still." },
  ];

  it("produces the shared whole-document narration text", () => {
    const { text } = speakableFromBlocks(blocks);
    expect(text).toBe(blocksToSourceText(blocks));
    expect(text.startsWith("Chapter One\n\n")).toBe(true);
  });

  it("records each block's offset so a marker needs no search", () => {
    const { text, blockStart } = speakableFromBlocks(blocks);
    expect(blockStart).toHaveLength(blocks.length);
    for (let i = 0; i < blocks.length; i++) {
      const head = blocks[i]!.text.slice(0, 12).replace(/\s+$/, "");
      expect(text.slice(blockStart[i]!, blockStart[i]! + head.length)).toBe(head);
    }
  });

  it("leaves a block the narrator dropped unresolved", () => {
    const starts = locateBlockStarts("Surviving paragraph.", [
      { kind: "para", text: "https://example.com/only-a-link" },
      { kind: "para", text: "Surviving paragraph." },
    ]);
    expect(starts[0]).toBe(-1);
    expect(starts[1]).toBe(0);
  });
});

describe("chapters from a block outline", () => {
  const blocks: BookBlock[] = [
    { kind: "heading", level: 1, text: "Contents" },
    { kind: "heading", level: 1, text: "Chapter One" },
    { kind: "para", text: PROSE },
    { kind: "heading", level: 1, text: "Chapter Two" },
    { kind: "para", text: "Night settled over the harbour and the boats were still." },
  ];
  const { text, blockStart } = speakableFromBlocks(blocks);

  it("drops a contents marker and keeps both chapters", () => {
    const doc = chaptersFromBlockOutline(
      text,
      blockStart,
      [
        { title: "Contents", level: 1, blockIndex: 0 },
        { title: "Chapter One", level: 1, blockIndex: 1 },
        { title: "Chapter Two", level: 1, blockIndex: 3 },
      ],
      "epub-spine"
    );
    expect(doc.source).toBe("epub-spine");
    expect(doc.chapters.map((chapter) => chapter.title)).toEqual([
      "Chapter One",
      "Chapter Two",
    ]);
    expect(text.slice(doc.chapters[1]!.charStart)).toMatch(/^Chapter Two/);
  });

  it("snaps a marker on a dropped block forward to the next narrated one", () => {
    const doc = chaptersFromBlockOutline(
      text,
      [-1, blockStart[1]!, blockStart[2]!, blockStart[3]!, blockStart[4]!],
      [
        { title: "Chapter One", level: 1, blockIndex: 0 },
        { title: "Chapter Two", level: 1, blockIndex: 3 },
      ],
      "epub-spine"
    );
    expect(doc.chapters[0]!.charStart).toBe(blockStart[1]);
  });

  it("nests by the source's own levels", () => {
    const nested = speakableFromBlocks([
      { kind: "heading", level: 1, text: "Part One" },
      { kind: "heading", level: 2, text: "Chapter One" },
      { kind: "para", text: PROSE },
      { kind: "heading", level: 2, text: "Chapter Two" },
      { kind: "para", text: "Night settled over the harbour and the boats were still." },
    ]);
    const doc = chaptersFromBlockOutline(
      nested.text,
      nested.blockStart,
      [
        { title: "Part One", level: 1, blockIndex: 0 },
        { title: "Chapter One", level: 2, blockIndex: 1 },
        { title: "Chapter Two", level: 2, blockIndex: 3 },
      ],
      "epub-spine"
    );
    expect(doc.chapters).toHaveLength(1);
    expect(doc.chapters[0]!.children?.map((chapter) => chapter.title)).toEqual([
      "Chapter One",
      "Chapter Two",
    ]);
  });
});

describe("TOC quality gates", () => {
  it("prefers the heading outline when a TOC loses chapters", () => {
    const toc = [
      { title: "One", level: 1, blockIndex: 0 },
      { title: "Two", level: 1, blockIndex: 0 },
    ];
    const headings = [0, 1, 2].map((blockIndex) => ({
      title: `Chapter ${blockIndex + 1}`,
      level: 1,
      blockIndex,
    }));
    const start = [0, 100, 200];
    expect(chooseOutline(toc, headings, start)).toBe(headings);
    expect(tocDistinctRatio(toc, start)).toBe(0.5);
  });

  it("trims a contents line that swallowed the chapter label", () => {
    expect(trimTrailingChapterLabel("I hope Mr. Bingley will like it. CHAPTER II.")).toBe(
      "CHAPTER II."
    );
    expect(trimTrailingChapterLabel("Chapter Two")).toBe("Chapter Two");
  });

  it("keeps a book whose only entry is furniture", () => {
    expect(filterTocEntries([{ title: "Contents" }])).toHaveLength(1);
    expect(
      filterTocEntries([{ title: "Contents" }, { title: "Chapter One" }]).map((e) => e.title)
    ).toEqual(["Chapter One"]);
  });
});

describe("book furniture", () => {
  it("recognises packaging labels but not real parts", () => {
    for (const label of ["Contents", "Imprint", "Colophon", "Uncopyright", "Titlepage", "Cover"]) {
      expect(isFurnitureHeading(label), label).toBe(true);
    }
    for (const label of ["Chapter One", "Preface", "Dedication", "Epilogue", "The Whale"]) {
      expect(isFurnitureHeading(label), label).toBe(false);
    }
  });

  it("drops Project Gutenberg's header and footer, wrapped banner and all", () => {
    const raw = [
      "The Project Gutenberg eBook of X",
      "",
      "Title: X",
      "",
      "*** START OF THE PROJECT GUTENBERG EBOOK X",
      "***",
      "",
      "Chapter One",
      "",
      PROSE,
      "",
      "*** END OF THE PROJECT GUTENBERG EBOOK X ***",
      "",
      "Section 1. General Terms of Use",
    ].join("\n");
    expect(stripGutenbergFurniture(raw)).toBe(`Chapter One\n\n${PROSE}`);
  });

  it("leaves a file with no banner alone", () => {
    expect(stripGutenbergFurniture(PROSE)).toBe(PROSE);
  });
});
