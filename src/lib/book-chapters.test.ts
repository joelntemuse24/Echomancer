import { describe, expect, it } from "vitest";
import {
  chapterDisplayTitle,
  chapterMatchList,
  chaptersFromHeadingLines,
  MAX_CHAPTER_TITLE_CHARS,
  parseChaptersDocument,
  resolveChapters,
  safeResolveChapters,
  withPartContextTitles,
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

  it("searches ahead when an outline entry is missing from the text", () => {
    const text = [
      "Chapter One",
      "The lamps were lit along the quay and the tide was turning before midnight.",
      "Chapter Three",
      "The boats were still for a long while before the morning came.",
    ].join("\n\n");
    const doc = resolveChapters(text, {
      source: "pdf-outline",
      titles: [
        { title: "Chapter One", level: 1 },
        { title: "Chapter Two (missing from the text)", level: 1 },
        { title: "Chapter Three", level: 1 },
      ],
    });
    expect(doc.chapters.map((chapter) => chapter.title)).toEqual([
      "Chapter One",
      "Chapter Three",
    ]);
  });

  it("aligns an outline label to a different in-text anchor", () => {
    const text = [
      "1",
      "The escalation starts here and the paragraph is long enough to read aloud.",
      "2",
      "Clausewitz and the argument continue in a full paragraph of reading.",
    ].join("\n\n");
    const doc = resolveChapters(text, {
      source: "epub-spine",
      titles: [
        { title: "Chapter 1: The Escalation to Extremes", level: 1, anchors: ["1"] },
        { title: "Chapter 2: Clausewitz and Hegel", level: 1, anchors: ["2"] },
      ],
    });
    expect(doc.chapters.map((chapter) => chapter.title)).toEqual([
      "Chapter 1: The Escalation to Extremes",
      "Chapter 2: Clausewitz and Hegel",
    ]);
    expect(doc.chapters[0]!.match).toBe("1");
    expect(text.slice(doc.chapters[1]!.charStart)).toMatch(/^2\n/);
    expect(chapterMatchList(doc).map((pair) => pair.match)).toEqual(["1", "2"]);
  });

  it("trusts the body's heading lines over an outline that matches under half its entries", () => {
    const text = [
      "Chapter One",
      "The lamps were lit along the quay and the tide was turning before midnight.",
      "Chapter Two",
      "Night settled over the harbour and the boats were still for a long while.",
      "Chapter Three",
      "The return brought the boat back into the harbour before the morning.",
    ].join("\n\n");
    const doc = resolveChapters(text, {
      source: "pdf-outline",
      titles: [
        { title: "Chapter One", level: 1 },
        { title: "Abridged Away Two", level: 1 },
        { title: "Abridged Away Three", level: 1 },
        { title: "Abridged Away Four", level: 1 },
        { title: "Abridged Away Five", level: 1 },
      ],
    });
    expect(doc.source).toBe("heading-lines");
    expect(doc.chapters.map((chapter) => chapter.title)).toEqual([
      "Chapter One",
      "Chapter Two",
      "Chapter Three",
    ]);
  });

  it("ignores a one-title outline that covers the whole book", () => {
    const text = [
      "Chapter One",
      "The lamps were lit along the quay and the tide was turning before midnight.",
      "Chapter Two",
      "Night settled over the harbour and the boats were still for a long while.",
    ].join("\n\n");
    const doc = resolveChapters(text, {
      source: "pdf-outline",
      titles: [{ title: "Chapter One", level: 1 }],
    });
    expect(doc.chapters.length).toBeGreaterThan(1);
    const giant = resolveChapters(text, {
      source: "pdf-outline",
      titles: [{ title: "The Whole Book, One Glued Title", level: 1 }],
    });
    expect(giant.chapters.length).toBeGreaterThan(0);
    expect(giant.source).toBe("heading-lines");
  });
});

describe("chapterDisplayTitle", () => {
  it("keeps Roman numerals uppercase inside a title-cased line", () => {
    expect(chapterDisplayTitle("CHAPTER IV")).toBe("Chapter IV");
    expect(chapterDisplayTitle("CHAPTER XII. MR. COLLINS")).toBe("Chapter XII. Mr. Collins");
    expect(chapterDisplayTitle("BOOK ONE: 1805")).toBe("Book One: 1805");
  });

  it("caps a glued paragraph at the title limit", () => {
    const long = `Chapter ${"x".repeat(MAX_CHAPTER_TITLE_CHARS + 100)}`;
    const title = chapterDisplayTitle(long);
    expect(title.length).toBeLessThanOrEqual(MAX_CHAPTER_TITLE_CHARS);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("withPartContextTitles", () => {
  it("prefixes a repeated label only when it appears under different books", () => {
    expect(
      withPartContextTitles([
        "Book One",
        "Chapter I",
        "Book Two",
        "Chapter I",
        "Epilogue",
        "Epilogue",
      ])
    ).toEqual([
      "Book One",
      "Book One · Chapter I",
      "Book Two",
      "Book Two · Chapter I",
      "Epilogue",
      "Epilogue",
    ]);
  });

  it("leaves unique titles alone", () => {
    const titles = ["Foreword", "Chapter One", "Coda"];
    expect(withPartContextTitles(titles)).toEqual(titles);
  });
});

describe("parseChaptersDocument", () => {
  it("round-trips the match line used for generation breaks", () => {
    const doc = chaptersFromHeadingLines(BOOK);
    const parsed = parseChaptersDocument(JSON.stringify(doc));
    expect(parsed).not.toBeNull();
    expect(parsed!.chapters.map((chapter) => chapter.title)).toEqual([
      "Foreword",
      "Chapter One",
      "Coda",
    ]);
    expect(parsed!.chapters[1]!.match).toBe("Chapter One");
  });

  it("accepts a legacy document without match lines", () => {
    const parsed = parseChaptersDocument(
      JSON.stringify({
        version: 1,
        source: "heading-lines",
        chapters: [{ index: 0, title: "Chapter One", level: 1, charStart: 0, charEnd: 10 }],
      })
    );
    expect(parsed!.chapters[0]!.match).toBeUndefined();
    expect(chapterMatchList(parsed!)).toEqual([{ match: "Chapter One", title: "Chapter One" }]);
  });
});
