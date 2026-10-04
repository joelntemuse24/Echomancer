import { afterEach, describe, expect, it } from "vitest";
import { resolveChapters } from "@/lib/book-chapters";
import { resolveChaptersForBook } from "@/lib/tts/chapter-choice";
import {
  acceptTopicPlacements,
  numberedParagraphs,
  placePartTopics,
  placePrintedTocTopics,
} from "@/lib/tts/topic-llm";

const saved = process.env.CHAPTER_TOPIC_LLM;

afterEach(() => {
  if (saved == null) delete process.env.CHAPTER_TOPIC_LLM;
  else process.env.CHAPTER_TOPIC_LLM = saved;
});

function jsonResponse(placements: unknown): typeof fetch {
  return async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ placements }) } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
}

describe("topic placement", () => {
  it("drops out-of-range and non-monotonic answers and keeps anchors", () => {
    const anchors = new Map<number, number>([[1, 4]]);
    const placed = acceptTopicPlacements(
      3,
      8,
      [
        { topic: 0, paragraph: 99 },
        { topic: 0, paragraph: 2 },
        { topic: 1, paragraph: 1 },
        { topic: 2, paragraph: 3 },
        { topic: 2, paragraph: 6 },
      ],
      anchors
    );
    expect([...placed.entries()]).toEqual([
      [0, 2],
      [1, 4],
      [2, 6],
    ]);
  });

  it("asks for paragraph numbers and will not move a verbatim anchor", async () => {
    const paragraphs = numberedParagraphs(
      [
        "Opening prose of the part sits here.",
        "The Missouri Compromise settled the question for a generation.",
        "Frontier towns grew after the railroad arrived and the settlers stayed.",
      ].join("\n\n"),
      100
    );
    const placed = await placePartTopics(
      ["The Missouri Compromise", "Frontier towns"],
      paragraphs,
      {
        apiKey: "test-key",
        signal: AbortSignal.timeout(5_000),
        callTimeoutMs: 1_000,
        fetch: jsonResponse([
          { topic: 0, paragraph: 1 },
          { topic: 1, paragraph: 3 },
          { topic: 1, paragraph: "none" },
        ]),
      }
    );
    expect(placed?.get(0)).toBe(2);
    expect(placed?.get(1)).toBe(3);
    expect(paragraphs[2]!.charStart).toBeGreaterThan(100);
  });

  it("returns null when the call times out", async () => {
    const paragraphs = numberedParagraphs("A paragraph that is not a topic title.\n\nAnother paragraph follows it.", 0);
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const placed = await placePartTopics(["Frontier towns"], paragraphs, {
      apiKey: "test-key",
      signal: AbortSignal.timeout(5_000),
      callTimeoutMs: 20,
      fetch: fetchImpl,
    });
    expect(placed).toBeNull();
  });

  it("stays on the verbatim tree unless CHAPTER_TOPIC_LLM=1", async () => {
    delete process.env.CHAPTER_TOPIC_LLM;
    const text = [
      "CONTENTS",
      "Preface",
      "PART ONE",
      "'A City on a Hill'",
      "Colonial America, 1580—1750",
      "The Missouri Compromise",
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
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      throw new Error("should not be called");
    };
    const doc = await resolveChaptersForBook(
      text,
      { source: "heading-lines", titles: [] },
      { fetch: fetchImpl, apiKey: "test-key" }
    );
    expect(called).toBe(false);
    expect(doc.source).toBe("printed-toc");
    expect(doc.chapters[1]?.children?.map((child) => child.title)).toEqual([
      "The Missouri Compromise",
    ]);

    process.env.CHAPTER_TOPIC_LLM = "1";
    const hinted = resolveChapters(text, { source: "heading-lines", titles: [] });
    const placed = await placePrintedTocTopics(
      text,
      hinted,
      { source: "heading-lines", titles: [] },
      {
        apiKey: "test-key",
        callTimeoutMs: 1_000,
        fetch: jsonResponse([{ topic: 0, paragraph: 1 }]),
      }
    );
    expect(placed?.chapters[1]?.children?.map((child) => child.title)).toEqual([
      "The Missouri Compromise",
    ]);
  });
});
