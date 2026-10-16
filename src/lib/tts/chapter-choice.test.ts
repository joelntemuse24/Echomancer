import { describe, expect, it, vi } from "vitest";
import { chooseChapterIndexes, chaptersFromCandidateIndexes, hasValidChapterStructure, resolveChaptersForBook } from "@/lib/tts/chapter-choice";

describe("chapter choice", () => {
  it("ignores indexes the model invents", async () => {
    const candidates = [
      { index: 0, title: "Preface", context: "This work is a labor of love." },
      { index: 1, title: "Part One", context: "The creation of the United States." },
    ];
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"indexes":[1, 9, -3, 1.5]}' } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    const indexes = await chooseChapterIndexes(candidates, ["Preface", "Part One"], {
      fetch: fetchImpl,
      apiKey: "test-key",
    });
    expect(indexes).toEqual([1]);
    const doc = chaptersFromCandidateIndexes(
      "Preface\n\nThis work is a labor of love and it goes on for a paragraph.\n\nPart One\n\nThe creation of the United States is a long story with many sentences in it.",
      candidates,
      indexes ?? []
    );
    expect(doc.chapters.map((chapter) => chapter.title)).toEqual(["Part One"]);
    expect(JSON.stringify(doc)).not.toContain("Invented Chapter");
  });

  it("skips the model when there is no key", async () => {
    const indexes = await chooseChapterIndexes(
      [{ index: 0, title: "Preface", context: "" }],
      [],
      { apiKey: "" }
    );
    expect(indexes).toBeNull();
  });
});


describe("structure preference", () => {
  const text = ["First Heading", "The first chapter tells a long story. ".repeat(30),
    "Second Heading", "The second chapter continues the story. ".repeat(30)].join("\n\n");
  it.each(["epub-spine", "pdf-outline"] as const)("prefers %s over AI", async (source) => {
    const fetchFn = vi.fn<typeof fetch>();
    const doc = await resolveChaptersForBook(text, { source, titles: [
      { title: "First Heading", level: 1 }, { title: "Second Heading", level: 1 },
    ] }, { fetch: fetchFn, apiKey: "key", host: "worker" });
    expect(doc.source).toBe(source);
    expect(doc.chapters).toHaveLength(2);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("uses printed contents without an AI call", async () => {
    const fetchFn = vi.fn<typeof fetch>();
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
    const doc = await resolveChaptersForBook(spoken, { source: "heading-lines", titles: [] },
      { fetch: fetchFn, apiKey: "key", host: "worker" });
    expect(doc.source).toBe("printed-toc");
    expect(fetchFn).not.toHaveBeenCalled();
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
});
