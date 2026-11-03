import { describe, expect, it, vi } from "vitest";
import {
  hasValidChapterStructure,
  resolveChaptersForBook,
} from "@/lib/tts/chapter-choice";
import { chaptersFromLength } from "@/lib/length-parts";

const text = ["First Heading", "The first chapter tells a long story. ".repeat(30),
  "Second Heading", "The second chapter continues the story. ".repeat(30)].join("\n\n");

describe("structure preference", () => {
  it.each(["epub-spine", "pdf-outline"] as const)("uses %s as the outline", async (source) => {
    const doc = await resolveChaptersForBook(
      text,
      {
        source,
        titles: [
          { title: "First Heading", level: 1 },
          { title: "Second Heading", level: 1 },
        ],
      },
      { host: "worker" }
    );
    expect(doc.source).toBe(source);
    expect(doc.chapters).toHaveLength(2);
  });

  it("uses printed contents", async () => {
    const spoken = [
      "CONTENTS",
      "Preface",
      "PART ONE",
      "'A City on a Hill'",
      "Colonial America, 1580—1750",
      "The Missouri Compromise",
      "The Lost Colony of Croatoan",
      "PART TWO",
      "'That the Free Constitution Be Sacredly Maintained'",
      "Revolutionary America, 1750—1815",
      "PREFACE",
      "This work is a labor of love. When I was a little boy my parents taught me a great deal of history, and the name of America scarcely intruded at school.",
      "PART ONE",
      "'A City on a Hill' Colonial America, 1580—1750 The creation of the United States of America is the greatest of all human adventures. The Missouri Compromise settled the question for a generation and the settlers stayed.",
      "PART TWO",
      "'That the Free Constitution Be Sacredly Maintained' Revolutionary America, 1750—1815 Washington led the continental army through a long war. The constitution was written after the peace and the people ratified it.",
    ].join("\n\n");
    const doc = await resolveChaptersForBook(
      spoken,
      { source: "heading-lines", titles: [] },
      { host: "worker" }
    );
    expect(doc.source).toBe("printed-toc");
  });

  it("validates printed contents and accepts single entries and repeated titles, and rejects invalid boundaries", () => {
    const chapter = (title: string, charStart: number) => ({ index: 0, title, level: 1, charStart, charEnd: text.length });
    const doc = { version: 1 as const, source: "printed-toc" as const, chapters: [chapter("First", 0), chapter("Second", 200)] };
    expect(hasValidChapterStructure(text, doc)).toBe(true);
    expect(hasValidChapterStructure(text, { ...doc, chapters: [chapter("First", 0)] })).toBe(true);
    expect(hasValidChapterStructure(text, { ...doc, chapters: [chapter("First", 0), chapter("FIRST.", 200)] })).toBe(true);
    expect(hasValidChapterStructure(text, { ...doc, chapters: [{ ...chapter("First", 0), children: [chapter("First child", 0)] }] })).toBe(true);
    for (const chapters of [[], [chapter("First", 200), chapter("Second", 0)],
      [chapter("First", -1)], [chapter("First", 0), chapter("Second", 0)]]) {
      expect(hasValidChapterStructure(text, { ...doc, chapters })).toBe(false);
    }
  });

  it("rejects an outline from a source that is not a chapter source", () => {
    const doc = {
      version: 1 as const,
      source: "none" as const,
      chapters: [{ index: 0, title: "First", level: 1, charStart: 0, charEnd: text.length }],
    };
    expect(hasValidChapterStructure(text, doc)).toBe(false);
  });
});

describe("a heading-lines book", () => {
  /** Chaptered body prose: the detector produces a correct, ordered outline. */
  const CHAPTERED = Array.from({ length: 10 }, (_, i) =>
    `Chapter ${i + 1}\n\nThe lamps were lit along the quay and the tide was turning before midnight, and the harbour settled into its long evening quiet.`
  ).join("\n\n");

  it("treats heading-lines as a valid structure", () => {
    const doc = {
      version: 1 as const,
      source: "heading-lines" as const,
      chapters: [{ index: 0, title: "Chapter 1", level: 1, charStart: 0, charEnd: CHAPTERED.length }],
    };
    expect(hasValidChapterStructure(CHAPTERED, doc)).toBe(true);
  });

  it("keeps the detected chapters", async () => {
    const doc = await resolveChaptersForBook(
      CHAPTERED,
      { source: "heading-lines", titles: [] },
      { host: "worker" }
    );
    expect(doc.source).toBe("heading-lines");
    expect(doc.chapters).toHaveLength(10);
    expect(doc.chapters[0]!.title).toMatch(/Chapter 1/);
  });

  it("gives an unmarked book labelled parts, not invented chapters", async () => {
    // Every line of this book is prose, so `outlineLooksUnmarked` cannot ask
    // for a heading list; `chaptersFromLength` is what a markerless book gets.
    const prose = Array.from({ length: 400 }, (_, i) =>
      `Paragraph ${i + 1} of a book with no headings, only narrative prose that runs on for a while.`
    ).join("\n\n");
    const doc = chaptersFromLength(prose);
    expect(doc.source).toBe("sections");
    expect(doc.chapters.every((chapter) => /^Part \d+$/.test(chapter.title))).toBe(true);
    expect(doc.chapters.length).toBeGreaterThan(1);
  });
});
