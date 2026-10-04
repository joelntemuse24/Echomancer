import { describe, expect, it } from "vitest";
import {
  chapterView,
  mediaSessionFields,
  normalizeChapters,
  sanitizePlaybackChapters,
  type PlayerChapter,
} from "./chapter-nav";

function ch(
  title: string,
  start: number,
  end: number,
  extra?: Partial<PlayerChapter>
): PlayerChapter {
  return { title, startSeconds: start, endSeconds: end, startFraction: 0, ...extra };
}

const flatNine: PlayerChapter[] = [
  ch("Part One", 0, 3600),
  ch("Part Two", 3600, 7200),
  ch("Part Three", 7200, 10800),
  ch("Part Four", 10800, 18000),
  ch("Part Five", 18000, 21600),
  ch("Part Six", 21600, 25200),
  ch("Part Seven", 25200, 28800),
  ch("Part Eight", 28800, 32400),
  ch("Part Nine", 32400, 36000),
];

const nested: PlayerChapter[] = [
  ch("Part One", 0, 1000, {
    children: [ch("Alpha", 0, 400), ch("Beta", 400, 1000)],
  }),
  ch("Part Two", 1000, 3640, {
    children: [ch("The Revolution", 1000, 2320), ch("After", 2320, 3640)],
  }),
];

describe("chapter skip", () => {
  it("restarts the current chapter once the playhead is more than 3 seconds in", () => {
    const view = chapterView([ch("A", 0, 100), ch("B", 100, 200)], 103.1, 200);
    expect(view.previous?.title).toBe("B");
    expect(view.previous?.startSeconds).toBe(100);
  });

  it("goes to the previous chapter at 3 seconds or less", () => {
    const chapters = [ch("A", 0, 100), ch("B", 100, 200)];
    expect(chapterView(chapters, 103, 200).previous?.title).toBe("A");
    expect(chapterView(chapters, 100, 200).previous?.title).toBe("A");
  });

  it("does nothing on the first chapter until it can restart", () => {
    const chapters = [ch("A", 0, 100), ch("B", 100, 200)];
    expect(chapterView(chapters, 2, 200).previous).toBeNull();
    expect(chapterView(chapters, 4, 200).previous?.startSeconds).toBe(0);
  });

  it("steps forward and stops on the last chapter", () => {
    const chapters = [ch("A", 0, 100), ch("B", 100, 200)];
    expect(chapterView(chapters, 50, 200).next?.title).toBe("B");
    expect(chapterView(chapters, 150, 200).next).toBeNull();
  });

  it("steps through sub-chapters and restarts the current one", () => {
    expect(chapterView(nested, 1000, 2000).previous?.title).toBe("Beta");
    expect(chapterView(nested, 1000, 2000).next?.title).toBe("After");
    const into = chapterView(nested, 1010, 2000);
    expect(into.previous?.title).toBe("The Revolution");
    expect(into.previous?.startSeconds).toBe(1000);
  });

  it("treats a part intro as the part, then steps into its first sub-chapter", () => {
    const book = [
      ch("Part One", 0, 100, {
        children: [ch("Later", 40, 100)],
      }),
      ch("Part Two", 100, 200),
    ];
    const intro = chapterView(book, 10, 200);
    expect(intro.previous?.startSeconds).toBe(0);
    expect(intro.next?.title).toBe("Later");
    expect(chapterView(book, 2, 200).previous).toBeNull();
  });

  it("seeks by fraction when the file has no stored seconds", () => {
    const chapters: PlayerChapter[] = [
      { title: "A", startFraction: 0 },
      { title: "B", startFraction: 0.5 },
    ];
    const view = chapterView(chapters, 110, 200);
    expect(view.previous?.title).toBe("B");
    expect(view.previous?.startFraction).toBe(0.5);
    expect(view.next).toBeNull();
  });
});

describe("now-playing line", () => {
  it("names a flat chapter, its place, and the time left", () => {
    expect(chapterView(flatNine, 13680, 36000).line).toBe(
      "Part Four · 4 of 9 · 1 h 12 m left in chapter"
    );
  });

  it("names the part and the sub-chapter", () => {
    expect(chapterView(nested, 1000, 2000).line).toBe(
      "Part Two · The Revolution · 22 m left"
    );
  });

  it("reads level-2 rows as sub-chapters under the part they follow", () => {
    const leveled = [
      ch("Part Two", 0, 2000, { level: 1 }),
      ch("The Revolution", 0, 1320, { level: 2 }),
      ch("After", 1320, 2000, { level: 2 }),
      ch("Part Three", 2000, 3000, { level: 1 }),
    ];
    const view = chapterView(leveled, 0, 3000);
    expect(view.line).toBe("Part Two · The Revolution · 22 m left");
    expect(view.ticks.map((tick) => tick.title)).toEqual(["Part Two", "Part Three"]);
    expect(chapterView(leveled, 2000, 3000).line).toBe(
      "Part Three · 2 of 2 · 16 m left in chapter"
    );
  });

  it("names the list before the first chapter has started", () => {
    const late = flatNine.map((chapter) => ({
      ...chapter,
      startSeconds: (chapter.startSeconds ?? 0) + 64,
      endSeconds: (chapter.endSeconds ?? 0) + 64,
    }));
    const preface = chapterView(late, 63, 36064);
    expect(preface.line).toBe("Chapters · 9");
    expect(preface.previous).toBeNull();
    expect(preface.next?.title).toBe("Part One");
    expect(chapterView(late, 0, 36064).line).toBe("Chapters · 9");
    expect(chapterView(late, 64, 36064).line).toBe(
      "Part One · 1 of 9 · 1 h left in chapter"
    );
  });

  it("is absent for a book with one chapter or none", () => {
    expect(chapterView([], 0, 10).enabled).toBe(false);
    expect(chapterView([], 0, 10).line).toBeNull();
    expect(chapterView([ch("Only", 0, 10)], 0, 10).line).toBeNull();
    expect(
      chapterView([ch("Part", 0, 10, { children: [ch("Only", 0, 10)] })], 0, 10).enabled
    ).toBe(false);
  });

  it("turns on for one part that has two sub-chapters", () => {
    const view = chapterView(
      [ch("Part", 0, 20, { children: [ch("One", 0, 10), ch("Two", 10, 20)] })],
      0,
      20
    );
    expect(view.enabled).toBe(true);
    expect(view.line).toBe("Part · One · 10 s left");
  });
});

describe("chapter list shape", () => {
  it("keeps a flat list flat", () => {
    const outline = normalizeChapters([ch("A", 0, 1), ch("B", 1, 2)]);
    expect(outline.parts.every((part) => part.children.length === 0)).toBe(true);
    expect(outline.steps.map((step) => step.title)).toEqual(["A", "B"]);
    expect(outline.ticks.map((tick) => tick.title)).toEqual(["A", "B"]);
  });

  it("marks only top-level chapters on the scrubber", () => {
    expect(chapterView(nested, 0, 2000).ticks.map((tick) => tick.title)).toEqual([
      "Part One",
      "Part Two",
    ]);
  });

  it("labels a row with its place, title, clock, and spoken length", () => {
    const chapters = [...flatNine];
    chapters[3] = ch("Part Four", 82877, 82877 + 11580, { subtitle: "The Long Night" });
    const view = chapterView(chapters, 82877, 200000);
    expect(view.rows[3]?.label).toBe(
      "Chapter 4 of 9, Part Four: The Long Night, starts 23:01:17, 3 hours 13 minutes"
    );
  });

  it("labels a sub-chapter under its part", () => {
    const view = chapterView(nested, 1000, 2000);
    expect(view.rows[1]?.children[0]?.label).toBe(
      "Chapter 2 of 2, Part Two: The Revolution, starts 16:40, 22 minutes"
    );
  });

  it("does not require a subtitle", () => {
    const view = chapterView([ch("Part Four", 0, 10), ch("Part Five", 10, 20)], 0, 20);
    expect(view.rows[0]?.subtitle).toBeUndefined();
    expect(view.rows[0]?.label).toBe(
      "Chapter 1 of 2, Part Four, starts 0:00, 10 seconds"
    );
  });

  it("prefers a children array and leaves a flat sibling alone", () => {
    const outline = normalizeChapters([
      ch("Part", 0, 10, { children: [ch("Inner", 0, 10)] }),
      ch("Loose", 10, 20, { level: 2 }),
    ]);
    expect(outline.parts.map((part) => part.title)).toEqual(["Part", "Loose"]);
    expect(outline.parts[0]?.children.map((child) => child.title)).toEqual(["Inner"]);
  });
});

describe("sanitizePlaybackChapters", () => {
  it("keeps subtitle, level, and children, and drops blank rows", () => {
    expect(
      sanitizePlaybackChapters([
        {
          title: "Part",
          startFraction: 0,
          subtitle: "  Night  ",
          index: 3,
          children: [
            { title: "One", startFraction: 0.2, level: 2 },
            { title: " ", startFraction: 0 },
          ],
        },
        { title: "", startFraction: 0 },
        null,
      ])
    ).toEqual([
      {
        index: 3,
        title: "Part",
        subtitle: "Night",
        startFraction: 0,
        children: [{ title: "One", startFraction: 0.2, level: 2 }],
      },
    ]);
  });

  it("returns nothing for a missing document", () => {
    expect(sanitizePlaybackChapters(null)).toEqual([]);
  });
});

describe("mediaSessionFields", () => {
  it("uses the book as the title, the chapter as artist, and the voice as album", () => {
    expect(
      mediaSessionFields({
        bookTitle: "Middlemarch",
        chapterLabel: "Part Two · The Revolution",
        voiceName: "Ava",
      })
    ).toEqual({
      title: "Middlemarch",
      artist: "Part Two · The Revolution",
      album: "Ava",
    });
    expect(mediaSessionFields({ bookTitle: "Middlemarch", voiceName: "Ava" })).toEqual({
      title: "Middlemarch",
      artist: "Ava",
    });
  });
});
