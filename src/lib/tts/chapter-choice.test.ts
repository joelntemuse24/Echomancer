import { describe, expect, it } from "vitest";
import { chooseChapterIndexes, chaptersFromCandidateIndexes } from "@/lib/tts/chapter-choice";

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
