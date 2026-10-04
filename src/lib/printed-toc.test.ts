import { describe, expect, it } from "vitest";
import { headingLineMatches, resolveChapters, restoreProtectedHeadingBreaks } from "@/lib/book-chapters";
import {
  chaptersFromPrintedToc,
  parsePrintedContents,
  placeTopicPhrase,
  subtitleFromLead,
} from "@/lib/printed-toc";
import { timePlaybackTree } from "@/lib/player/playback-chapters";

const HISTORY = [
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

describe("printed contents", () => {
  it("reads a part title and era, including an unquoted title", () => {
    const entries = parsePrintedContents([
      "CONTENTS",
      "PART FIVE",
      "Huddled Masses and Crosses of Gold",
      "Industrial America, 1870—1912",
      "The Significance of the Frontier",
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.label).toBe("Part Five");
    expect(entries[0]!.subtitle).toBe(
      "Huddled Masses and Crosses of Gold · Industrial America, 1870—1912"
    );
    expect(entries[0]!.topics.map((topic) => topic.title)).toEqual([
      "The Significance of the Frontier",
    ]);
  });

  it("places the nine-part shape and only a unique topic", () => {
    const doc = resolveChapters(HISTORY, { source: "heading-lines", titles: [] });
    expect(doc.source).toBe("printed-toc");
    expect(doc.chapters.map((chapter) => chapter.title)).toEqual([
      "Preface",
      "Part One",
      "Part Two",
    ]);
    expect(doc.chapters[0]!.subtitle).toBeUndefined();
    expect(doc.chapters[1]!.subtitle).toMatch(/City on a Hill/);
    expect(doc.chapters[1]!.subtitle).toMatch(/Colonial America/);
    const topics = doc.chapters[1]!.children?.map((child) => child.title) ?? [];
    expect(topics).toEqual(["The Missouri Compromise"]);
    expect(topics).not.toContain("The Lost Colony of Croatoan");
    const titles = JSON.stringify(doc);
    for (const junk of ["People", "ISBN", "5 The", "5 White", "XIV.", "Too Bad"]) {
      expect(titles).not.toContain(junk);
    }
  });

  it("maps a printed page number through the part offset", () => {
    const text = [
      "PART ONE",
      "The opening of this part is long enough to count as narration for the body test. A second sentence keeps it prose.",
      "The frontier towns grew quickly after the railroad arrived and the settlers stayed.",
      "PART TWO",
      "The second part also has narration that runs for a while and does not collapse. A second sentence ends it.",
    ].join("\n\n");
    const pageTwo = text.indexOf("The frontier towns");
    const doc = chaptersFromPrintedToc(text, {
      tocLines: [
        "CONTENTS",
        "PART ONE    1",
        "Frontier towns    2",
        "PART TWO    4",
      ],
      pageStarts: [0, pageTwo, text.indexOf("PART TWO"), text.length],
    });
    expect(doc?.chapters[0]?.children?.[0]?.title).toBe("Frontier towns");
    expect(doc?.chapters[0]?.children?.[0]?.charStart).toBe(pageTwo);
  });

  it("drops a topic that is only a generic word", () => {
    const part =
      "The impact was felt across the valley and the people spoke of it for years afterwards in every town.";
    expect(placeTopicPhrase(part, "The Impact", 0)).toBeNull();
  });

  it("keeps a quoted contents line as a topic", () => {
    const entries = parsePrintedContents([
      "CONTENTS",
      "PART ONE",
      "'A City on a Hill'",
      "Colonial America, 1580—1750",
      "`The Natural Inheritance of the Elect Nation'",
    ]);
    expect(entries[0]!.topics.map((topic) => topic.title)).toEqual([
      "The Natural Inheritance of the Elect Nation",
    ]);
  });

  it("drops a quote that broke across a contents line", () => {
    const entries = parsePrintedContents([
      "CONTENTS",
      "PART FOUR",
      "`The Almost Chosen People'",
      "Civil War America, 1850—1870",
      "TOO BAD!’ The Triumph and Tragedy of Lincoln",
      "The Rise of Lincoln",
    ]);
    expect(entries[0]!.topics.map((topic) => topic.title)).toEqual(["The Rise of Lincoln"]);
  });

  it("places a later unique pair when the first distinctive word is common", () => {
    const filler = "The great ships sailed onward across the sea. ";
    const body = `${filler.repeat(6)}The jamestown foothold held through the first winter and the settlers stayed.`;
    const at = placeTopicPhrase(body, "Jamestown: The First Permanent Foothold", 0);
    const jamestown = body.toLowerCase().indexOf("jamestown");
    expect(at).toBeGreaterThanOrEqual(jamestown);
    expect(at).toBeLessThan(jamestown + 40);
    const twice =
      "The jamestown foothold held. Later the jamestown foothold failed and the people left.";
    expect(placeTopicPhrase(twice, "Jamestown Foothold", 0)).toBeNull();
  });

  it("does not treat a common pair as the rarer words in the topic", () => {
    const text = [
      "The collapse of American power followed the war and the people paid the price.",
      "Soviet policy shifted in the next decade and the budget grew slowly afterwards.",
      "Rearmament waited until the factories were ready and the treasury agreed.",
    ].join(" ");
    expect(placeTopicPhrase(text, "Rearmament and the Collapse of Soviet Power", 0)).toBeNull();
  });

  it("keeps a heading that cleanup glued into the previous sentence", () => {
    const glued = "democracy. PART THREE 'A General Happy Mediocrity Prevails' and the sentence continues here.";
    expect(headingLineMatches(glued, "PART THREE")).toBe(true);
    expect(headingLineMatches("chapter in the spring", "chapter i")).toBe(false);
    const restored = restoreProtectedHeadingBreaks(glued, ["PART THREE"]);
    expect(restored).toMatch(/\n\nPART THREE\n\n/);
  });

  it("builds a subtitle from a quoted lead", () => {
    expect(
      subtitleFromLead(
        "'A General Happy Mediocrity Prevails' Democratic America, 1815—1850 The sentence continues."
      )
    ).toBe("'A General Happy Mediocrity Prevails' · Democratic America, 1815—1850");
  });
});

describe("playback children", () => {
  it("times a child from its offset inside a section", () => {
    const chapters = timePlaybackTree(
      [
        {
          index: 0,
          title: "Part One",
          startFraction: 0,
          charStart: 0,
          children: [
            {
              index: 0,
              title: "Frontier",
              startFraction: 0,
              level: 2,
              charStart: 500,
            },
          ],
        },
      ],
      [{ charStart: 0, charEnd: 1000 }],
      [0],
      100
    );
    expect(chapters[0]?.startSeconds).toBe(0);
    expect(chapters[0]?.children?.[0]?.startSeconds).toBe(50);
    expect(chapters[0]?.children?.[0]?.endSeconds).toBe(100);
  });
});
