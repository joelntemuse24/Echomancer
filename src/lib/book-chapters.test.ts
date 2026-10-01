import { describe, expect, it } from "vitest";
import {
  chaptersFromHeadingLines,
  resolveChapters,
  safeResolveChapters,
} from "./book-chapters";

const BOOK = [
  "Foreword",
  "The lamps were lit along the quay and the tide was turning before midnight.",
  "Chapter One",
  "Night settled over the harbour and the boats were still for a long while.",
  "Coda",
  "The notes were brief and the harbour was quiet again by morning.",
].join("\n\n");

describe("chaptersFromHeadingLines", () => {
  it("lists front matter, chapters, and a coda with offsets into the text", () => {
    const doc = chaptersFromHeadingLines(BOOK);
    expect(doc.source).toBe("heading-lines");
    expect(doc.chapters.map((chapter) => chapter.title)).toEqual([
      "Foreword",
      "Chapter One",
      "Coda",
    ]);
    expect(BOOK.slice(doc.chapters[0]!.charStart, doc.chapters[1]!.charStart)).toMatch(
      /^Foreword/
    );
    expect(BOOK.slice(doc.chapters[1]!.charStart, doc.chapters[2]!.charStart)).toMatch(
      /^Chapter One/
    );
    expect(BOOK.slice(doc.chapters[2]!.charStart)).toMatch(/^Coda/);
  });

  it("keeps a later chapter that reuses a number when the line is its own heading", () => {
    const text = [
      "Chapter 1",
      "The escalation starts here and the paragraph is long enough to read aloud.",
      "Chapter 2",
      "Clausewitz and the argument continue in a full paragraph of reading.",
      "Chapter 3",
      "The duel is the subject of this paragraph and it keeps going onward.",
      "Chapter 4",
      "The sacred follows the duel in this paragraph of the book itself.",
      "Chapter 1",
      "The escalation returns only as a citation inside a later chapter.",
      "Chapter 5",
      "Sorrow is the subject of this later paragraph in the book.",
    ].join("\n\n");
    expect(chaptersFromHeadingLines(text).chapters.map((chapter) => chapter.title)).toEqual([
      "Chapter 1",
      "Chapter 2",
      "Chapter 3",
      "Chapter 4",
      "Chapter 1",
      "Chapter 5",
    ]);
  });

  it("keeps one copy when a running header repeats the chapter title", () => {
    const text = ["Chapter 3", "Body.", "Chapter 3", "Body.", "Chapter 3", "Body.", "Chapter 3"].join(
      "\n\n"
    );
    expect(chaptersFromHeadingLines(text).chapters.map((chapter) => chapter.title)).toEqual([
      "Chapter 3",
    ]);
  });

  it("does not treat a sentence that mentions notes as a chapter", () => {
    const text =
      "Notes on the treaty stayed in the paragraph and were not a heading at all.\n\nThe lamps were lit along the quay for a long time.";
    expect(chaptersFromHeadingLines(text).chapters).toEqual([]);
  });
});

describe("resolveChapters", () => {
  it("prefers EPUB spine titles when they still appear as paragraphs", () => {
    const doc = resolveChapters(BOOK, {
      source: "epub-spine",
      titles: [
        { title: "Foreword", level: 1 },
        { title: "Chapter One", level: 1 },
      ],
    });
    expect(doc.source).toBe("epub-spine");
    expect(doc.chapters.map((chapter) => chapter.title)).toEqual([
      "Foreword",
      "Chapter One",
    ]);
    expect(doc.chapters[0]!.level).toBe(1);
  });

  it("falls open to an empty outline instead of throwing", () => {
    const doc = safeResolveChapters("   ", {
      source: "docx-heading",
      titles: [{ title: "Missing", level: 1 }],
    });
    expect(doc).toEqual({ version: 1, source: "none", chapters: [] });
  });

  it("returns source none when title alignment throws", () => {
    const doc = safeResolveChapters(
      "The lamps were lit along the quay and the tide was turning before midnight.",
      {
        source: "epub-spine",
        titles: undefined as unknown as { title: string; level: number }[],
      }
    );
    expect(doc).toEqual({ version: 1, source: "none", chapters: [] });
  });
});
