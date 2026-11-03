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

describe("a valid heading-lines outline is not sent to the model", () => {
  /** Chaptered body prose: the detector produces a correct, ordered outline. */
  const CHAPTERED = Array.from({ length: 10 }, (_, i) =>
    `Chapter ${i + 1}\n\nThe lamps were lit along the quay and the tide was turning before midnight, and the harbour settled into its long evening quiet.`
  ).join("\n\n");

  /**
   * Answers with an outline that locates cleanly in CHAPTERED. "A single bad
   * chapter" is deliberately absent from the text so a replacement is easy to
   * spot, and the opening has enough words to survive `parseWindowChapters`.
   */
  function countingFetch() {
    const calls: string[] = [];
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      calls.push(String(init?.body ?? ""));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ chapters: [
            { title: "Chapter 1", level: 1, opening: "Chapter 1 The lamps were lit along the quay" },
          ] }) } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;
    return { fetchFn, calls };
  }

  it("treats heading-lines as a valid structure", () => {
    const doc = {
      version: 1 as const,
      source: "heading-lines" as const,
      chapters: [{ index: 0, title: "Chapter 1", level: 1, charStart: 0, charEnd: CHAPTERED.length }],
    };
    expect(hasValidChapterStructure(CHAPTERED, doc)).toBe(true);
  });

  it("keeps the detected chapters and makes no model call", async () => {
    const { fetchFn, calls } = countingFetch();
    const doc = await resolveChaptersForBook(
      CHAPTERED,
      { source: "heading-lines", titles: [] },
      { host: "worker", fetch: fetchFn, apiKey: "key", budgetMs: 5_000 }
    );
    expect(doc.source).toBe("heading-lines");
    expect(doc.chapters).toHaveLength(10);
    expect(doc.chapters[0]!.title).toMatch(/Chapter 1/);
    // The regression: this used to call the model and could replace ten
    // correct chapters with whatever the model answered.
    expect(calls).toHaveLength(0);
  });

  it("still asks the model when the caller forces it", async () => {
    const { fetchFn, calls } = countingFetch();
    await resolveChaptersForBook(
      CHAPTERED,
      { source: "heading-lines", titles: [] },
      { host: "worker", fetch: fetchFn, apiKey: "key", budgetMs: 5_000, forceAi: true }
    );
    expect(calls.length).toBeGreaterThan(0);
  }, 20_000);

  it("still asks the model for a book with no headings at all", async () => {
    const prose = Array.from({ length: 30 }, (_, i) =>
      `Paragraph ${i + 1} of a book with no headings, only narrative prose that runs on.`
    ).join("\n\n");
    const { fetchFn, calls } = countingFetch();
    const doc = await resolveChaptersForBook(
      prose,
      { source: "heading-lines", titles: [] },
      { host: "worker", fetch: fetchFn, apiKey: "key", budgetMs: 5_000, minChars: 0 }
    );
    // Nothing to detect, so the model is the only possible source.
    expect(calls.length).toBeGreaterThan(0);
    // The canned reply locates in CHAPTERED, not here, so the outline is
    // dropped — what matters is that the model was consulted at all.
    expect(doc.chapters.length).toBe(0);
  }, 20_000);
});
