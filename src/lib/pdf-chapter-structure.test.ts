/**
 * The PDF chapter path, end to end through the real extractor helpers.
 *
 * These cover three defects that each made an embedded outline unusable:
 *
 * 1. The block outline was returned beside `hint` instead of on it, so every
 *    intake path that forwarded `hint` dropped the markers.
 * 2. `pageStarts` was relocated twice — once against the normalized text and
 *    again against the speakable text — so a page's offset drifted past its own
 *    text and an outline destination resolved to the wrong paragraph.
 * 3. An outline entry whose title could not be matched in the prose was
 *    discarded, which turned a complete outline into the printed contents page.
 */

import { describe, expect, it } from "vitest";
import { alignTitles, resolveChapters } from "@/lib/book-chapters";
import { relocatePageStarts } from "@/lib/page-offsets";
import { pdfBlocksFromParagraphs } from "@/lib/pdf-blocks";
import type { PdfParagraph } from "@/lib/pdf-line-unwrap";
import { structureForText, MIN_BLOCK_LOCATE_RATE } from "@/lib/uploads/extract-structure";
import { toSpeakableText } from "@/lib/tts/speakable-text";

function prose(sentence: string, times = 5): string {
  return Array.from({ length: times }, () => sentence).join(" ");
}

/** Every title in the tree, document order, children included. */
function titles(nodes: { title: string; children?: unknown[] }[]): string[] {
  return nodes.flatMap((node) => [
    node.title,
    ...titles((node.children ?? []) as typeof nodes),
  ]);
}

const CHAPTERS = [
  "Chapter One",
  "Chapter Two",
  "Chapter Three",
  "Chapter Four",
  "Chapter Five",
];

const BODY = [
  prose("The lamps were lit along the quay and the tide was turning before midnight.", 6),
  prose("Night settled over the harbour and the boats were still for a long while.", 6),
  prose("The return brought the boat back into the harbour before the morning came.", 6),
  prose("The ledger recorded every crossing and the clerk signed each entry in turn.", 6),
  prose("The verdict ended the season and the harbour emptied again before winter.", 6),
];

describe("PDF outline survives a title the prose does not repeat", () => {
  /**
   * A bare numeral chapter list is the shape that broke this: Standard Ebooks
   * prints "I", "II"… and `alignTitles` found 3 of 62, so the whole outline was
   * abandoned for the contents page.
   */
  it("places an outline entry whose numeral is not its own paragraph", () => {
    const spoken = [CHAPTERS[0]!, BODY[0]!, CHAPTERS[1]!, BODY[1]!, CHAPTERS[2]!, BODY[2]!].join("\n\n");
    const pageStarts = [0, spoken.indexOf(CHAPTERS[1]!), spoken.indexOf(CHAPTERS[2]!)];
    // The outline names the chapters by numeral, which no paragraph repeats.
    const doc = alignTitles(
      spoken,
      [
        { title: "I", level: 1, charStart: 0 },
        { title: "II", level: 1, charStart: pageStarts[1]! },
        { title: "III", level: 1, charStart: pageStarts[2]! },
      ],
      "pdf-outline",
      pageStarts
    );
    expect(titles(doc.chapters)).toEqual(["I", "II", "III"]);
    expect(doc.chapters[1]!.charStart).toBe(pageStarts[1]);
    expect(doc.chapters[2]!.charStart).toBe(pageStarts[2]);
  });

  it("keeps a matcher-found entry and a page-placed entry in reading order", () => {
    const spoken = [CHAPTERS[0]!, BODY[0]!, CHAPTERS[1]!, BODY[1]!, CHAPTERS[2]!, BODY[2]!].join("\n\n");
    const second = spoken.indexOf(CHAPTERS[1]!);
    const third = spoken.indexOf(CHAPTERS[2]!);
    const doc = alignTitles(
      spoken,
      [
        { title: CHAPTERS[0]!, level: 1, charStart: 0 },
        { title: "II", level: 1, charStart: second },
        { title: CHAPTERS[2]!, level: 1, charStart: third },
      ],
      "pdf-outline",
      [0, second, third]
    );
    expect(titles(doc.chapters)).toEqual([CHAPTERS[0], "II", CHAPTERS[2]]);
    const starts = doc.chapters.map((chapter) => chapter.charStart);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});

describe("page offsets are relocated once, against the stored text", () => {
  /**
   * Relocating an already-relocated array is not idempotent, and it is what put
   * 83 of 506 Pro Git pages past their own text.
   */
  it("is idempotent when the text did not move", () => {
    const text = [CHAPTERS[0]!, BODY[0]!, CHAPTERS[1]!, BODY[1]!].join("\n\n");
    const probes = [CHAPTERS[0]!, CHAPTERS[1]!];
    const expected = [0, text.indexOf(CHAPTERS[1]!)];
    const once = relocatePageStarts(text, probes, expected);
    const twice = relocatePageStarts(text, probes, once);
    expect(once).toEqual(expected);
    expect(twice).toEqual(once);
  });

  it("finds every page when the stored text dropped a line between them", () => {
    // Real probes are a page's leading text (~40 characters). The anchor needs
    // enough of it to be unique, so a bare label cannot be re-anchored.
    const probes = CHAPTERS.slice(0, 3).map((chapter, i) => `${chapter} ${BODY[i]!}`);
    // The unwrapped text keeps a page marker the speakable text drops, so the
    // measured offsets are all past where those pages start in the stored text.
    const unwrapped = probes
      .map((probe, i) => `page ${i + 1}\n\n${probe}`)
      .join("\n\n");
    const stored = probes.join("\n\n");
    const measured = probes.map((probe) => unwrapped.indexOf(probe));
    expect(measured.every((at) => at >= 0)).toBe(true);
    const starts = relocatePageStarts(stored, probes, measured);
    expect(starts).toHaveLength(probes.length);
    for (let i = 0; i < probes.length; i++) {
      expect(stored.slice(starts[i]!).startsWith(probes[i]!)).toBe(true);
    }
  });
});

describe("structureForText", () => {
  const text = toSpeakableText([CHAPTERS[0]!, BODY[0]!, CHAPTERS[1]!, BODY[1]!].join("\n\n"), {
    normalizeTitles: false,
  });
  // The blocks a PDF's single paragraph pass yields for that same text, so
  // every block is findable in the stored string.
  const blocks = pdfBlocksFromParagraphs([
    { text: CHAPTERS[0]!, page: 0 },
    { text: BODY[0]!, page: 0 },
    { text: CHAPTERS[1]!, page: 1 },
    { text: BODY[1]!, page: 1 },
  ] satisfies PdfParagraph[]);

  it("keeps the block outline when every block can be located", () => {
    const hint = structureForText(
      {
        source: "epub-spine",
        titles: [],
        blockOutline: [
          { title: CHAPTERS[0]!, level: 1, blockIndex: 0 },
          { title: CHAPTERS[1]!, level: 1, blockIndex: 2 },
        ],
      },
      text,
      blocks
    );
    expect(hint.blocks).toHaveLength(4);
    expect(hint.blockOutline).toHaveLength(2);
    expect(hint.blockStart?.length).toBe(4);
  });

  it("drops a block outline that cannot be located, so page placement is used", () => {
    // Block text the stored string does not contain at all — a PDF whose two
    // pipelines disagreed. The markers must not be half-placed.
    const alien = pdfBlocksFromParagraphs([
      { text: "Unrelated line one", page: 0 },
      { text: "Unrelated line two", page: 0 },
      { text: "Unrelated line three", page: 1 },
    ]);
    const hint = structureForText(
      {
        source: "pdf-outline",
        titles: [{ title: "Chapter One", level: 1 }],
        blockOutline: [
          { title: "One", level: 1, blockIndex: 0 },
          { title: "Two", level: 1, blockIndex: 2 },
        ],
      },
      text,
      alien
    );
    expect(MIN_BLOCK_LOCATE_RATE).toBeGreaterThan(0.5);
    expect(hint.blocks).toBeUndefined();
    expect(hint.blockOutline).toBeUndefined();
    // The human-readable titles survive for the alignment path.
    expect(hint.titles).toHaveLength(1);
  });

  it("marks a heading paragraph as a heading block on its own page", () => {
    expect(blocks[0]).toMatchObject({ kind: "heading", source: { page: 0 } });
    expect(blocks[1]).toMatchObject({ kind: "para", source: { page: 0 } });
    expect(blocks[2]).toMatchObject({ kind: "heading", source: { page: 1 } });
  });});

describe("resolveChapters keeps the source's own outline", () => {
  it("does not fall back to heading lines when the outline is complete", () => {
    const spoken = [CHAPTERS[0]!, BODY[0]!, CHAPTERS[1]!, BODY[1]!, CHAPTERS[2]!, BODY[2]!].join("\n\n");
    const doc = resolveChapters(spoken, {
      source: "pdf-outline",
      titles: CHAPTERS.slice(0, 3).map((title) => ({ title, level: 1 })),
      pageStarts: [0, spoken.indexOf(CHAPTERS[1]!), spoken.indexOf(CHAPTERS[2]!)],
    });
    expect(doc.source).toBe("pdf-outline");
    expect(titles(doc.chapters)).toEqual(CHAPTERS.slice(0, 3));
  });
});
