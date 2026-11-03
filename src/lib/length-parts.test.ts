import { describe, expect, it } from "vitest";
import {
  chaptersFromLength,
  lengthPartCount,
  outlineLooksUnmarked,
  splitIntoLengthParts,
} from "@/lib/length-parts";
import type { BookChapter } from "@/lib/book-chapters";

function paragraph(index: number): string {
  return `Paragraph ${index}. `.repeat(40).trim();
}

function book(paragraphs: number): string {
  return Array.from({ length: paragraphs }, (_, i) => paragraph(i)).join("\n\n");
}

describe("length-based parts", () => {
  it("splits a long unmarked book at paragraph boundaries", () => {
    const text = book(400);
    const starts = splitIntoLengthParts(text, 4);
    expect(starts).toHaveLength(4);
    expect(starts[0]).toBe(0);
    for (const start of starts.slice(1)) {
      // Each part begins at the start of a paragraph, never mid-sentence.
      expect(start === 0 || text.slice(start - 2, start)).toBe("\n\n");
    }
  });

  it("labels the parts and never invents a title", () => {
    const doc = chaptersFromLength(book(400));
    expect(doc.source).toBe("sections");
    expect(doc.chapters.length).toBeGreaterThanOrEqual(2);
    expect(doc.chapters.map((chapter) => chapter.title)).toEqual(
      doc.chapters.map((_, i) => `Part ${i + 1}`)
    );
  });

  it("scales the part count with the book, within limits", () => {
    expect(lengthPartCount(10_000)).toBe(2);
    expect(lengthPartCount(1_600_000)).toBe(20);
    expect(lengthPartCount(99_000_000)).toBe(24);
  });

  it("keeps the whole text covered once", () => {
    const text = book(300);
    const doc = chaptersFromLength(text);
    expect(doc.chapters[0]!.charStart).toBe(0);
    expect(doc.chapters[doc.chapters.length - 1]!.charEnd).toBe(text.length);
    for (let i = 1; i < doc.chapters.length; i++) {
      expect(doc.chapters[i]!.charStart).toBe(doc.chapters[i - 1]!.charEnd);
    }
  });
});

describe("outlineLooksUnmarked", () => {
  function chapters(titles: string[], match?: (title: string) => string): BookChapter[] {
    return titles.map((title, i) => ({
      index: i,
      title,
      level: 1,
      charStart: i * 1000,
      charEnd: (i + 1) * 1000,
      match: match ? match(title) : title,
    }));
  }

  const HEADLINES = [
    "In The Heart Of The Hibernian Metropolis",
    "The Wearer Of The Crown",
    "Gentlemen Of The Press",
    "William Brayden, Esquire Of Oaklands",
    "The Crozier And The Pen",
    "Respected Dublin Burgess",
    "How A Great Daily Organ Is Turned Out",
    "We See The Canvaser At Work",
  ];

  it("rejects a run of all-caps headlines with no chapter labels", () => {
    expect(
      outlineLooksUnmarked(chapters(HEADLINES, (t) => t.toUpperCase()), "heading-lines")
    ).toBe(true);
  });

  it("keeps a real chapter list", () => {
    const real = ["Chapter I", "Chapter II", "Chapter III", "Chapter IV", "Chapter V", "Chapter VI"];
    expect(outlineLooksUnmarked(chapters(real), "heading-lines")).toBe(false);
  });

  it("keeps a scientific paper's section titles", () => {
    // Real section titles, unlabelled and short — but not shouted, and few.
    const paper = ["Introduction", "Related Work", "Model", "Experiments", "Results", "Discussion"];
    expect(outlineLooksUnmarked(chapters(paper), "heading-lines")).toBe(false);
  });

  it("keeps a chaptered book that also picked up in-page heads", () => {
    const mixed = [
      "CHAPTER I",
      "CHAPTER II",
      "JONATHAN HARKER'S JOURNAL",
      "CHAPTER III",
      "MINA MURRAY'S JOURNAL",
      "CHAPTER IV",
    ];
    expect(outlineLooksUnmarked(chapters(mixed, (t) => t), "heading-lines")).toBe(false);
  });

  it("never second-guesses a structured source", () => {
    expect(
      outlineLooksUnmarked(chapters(HEADLINES, (t) => t.toUpperCase()), "epub-spine")
    ).toBe(false);
  });
});
