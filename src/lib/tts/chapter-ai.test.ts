import { afterEach, describe, expect, it } from "vitest";
import { timePlaybackTree } from "@/lib/player/playback-chapters";
import { resolveChaptersForBook } from "@/lib/tts/chapter-choice";
import {
  buildFoldedCache,
  chapterAiAllowedHere,
  chapterAiEnabled,
  fuzzyLocateOpening,
  locateOpeningWords,
  mergeLocatedChapters,
  parseWindowChapters,
  resolveAiChapters,
  snapChapterStart,
  splitChapterWindows,
  type LocatedChapter,
} from "@/lib/tts/chapter-ai";

const ENV_KEYS = [
  "CHAPTER_AI_ENABLED",
  "CHAPTER_AI_MODEL",
  "CHAPTER_AI_WINDOW_CHARS",
  "CHAPTER_AI_CONCURRENCY",
  "CHAPTER_AI_TIMEOUT_MS",
  "CHAPTER_AI_BUDGET_MS",
  "OPENROUTER_API_KEY",
  "OPEN_ROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "LISTEN_PREP_MODEL",
  "VERCEL",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

const BOOK = [
  "Preface",
  "A short note before the story begins in earnest.",
  "Chapter One",
  "It was a bright cold day in April and the clocks were striking thirteen while the city woke.",
  "More of the first chapter keeps going here with plenty of body text to read aloud.",
  "The morning unfolded slowly across the rooftops and chimneys, and the streets filled with carts and voices and the smell of fresh bread from the corner bakery by the old stone bridge.",
  "Chapter Two",
  "The sun rose over the quiet village while birds sang in the tall green trees.",
  "The second chapter continues with its own story and several more sentences of narration.",
  "Evening came gently over the hills and the lamps were lit one by one along the winding lane that led down to the mill pond where the ducks were already asleep among the reeds.",
].join("\n\n");

function chatFetch(contents: (string | null)[]): typeof fetch {
  let calls = 0;
  const fn = (async () => {
    const content = contents[Math.min(calls, contents.length - 1)];
    calls += 1;
    if (content == null) throw new Error("network down");
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
    };
  }) as unknown as typeof fetch;
  (fn as unknown as { calls: () => number }).calls = () => calls;
  return fn;
}

function failedFetch(): typeof fetch {
  return (async () => ({
    ok: false,
    status: 500,
    json: async () => ({}),
  })) as unknown as typeof fetch;
}

const AI_REPLY = JSON.stringify({
  chapters: [
    {
      title: "Chapter One",
      level: 1,
      opening: "It was a bright cold day in April and the clocks",
    },
    {
      title: "Chapter Two",
      level: 1,
      opening: "The sun rose over the quiet village while birds",
    },
  ],
});

describe("chapterAiEnabled", () => {
  it("is the default when a key exists", () => {
    process.env.OPENROUTER_API_KEY = "or-key";
    delete process.env.CHAPTER_AI_ENABLED;
    expect(chapterAiEnabled()).toBe(true);
  });

  it("opts out and needs a key", () => {
    process.env.OPENROUTER_API_KEY = "or-key";
    process.env.CHAPTER_AI_ENABLED = "0";
    expect(chapterAiEnabled()).toBe(false);
    delete process.env.CHAPTER_AI_ENABLED;
    delete process.env.OPENROUTER_API_KEY;
    expect(chapterAiEnabled()).toBe(false);
  });

  it("never runs on Vercel or the fallback hosts", () => {
    expect(chapterAiAllowedHere("node")).toBe(true);
    expect(chapterAiAllowedHere("worker")).toBe(true);
    expect(chapterAiAllowedHere("inline")).toBe(false);
    expect(chapterAiAllowedHere("cloudflare")).toBe(false);
    expect(chapterAiAllowedHere(undefined)).toBe(false);
    process.env.VERCEL = "1";
    expect(chapterAiAllowedHere("worker")).toBe(false);
  });
});

describe("splitChapterWindows", () => {
  it("keeps a short book in one window", () => {
    const windows = splitChapterWindows(BOOK);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ start: 0, end: BOOK.length });
  });

  it("splits a long book into tagged overlapping windows", () => {
    const para = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20);
    const text = Array.from({ length: 60 }, (_, i) => `Section ${i}\n\n${para}`).join("\n\n");
    const windows = splitChapterWindows(text, 60_000);
    expect(windows.length).toBeGreaterThan(1);
    expect(windows[0]!.start).toBe(0);
    for (const window of windows) {
      expect(text.slice(window.start, window.end)).toBe(window.text);
    }
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]!.start).toBeLessThan(windows[i - 1]!.end);
    }
  });
});

describe("parseWindowChapters", () => {
  it("parses chapters and drops short openings", () => {
    const rows = parseWindowChapters(
      '```json\n{"chapters":[{"title":"Chapter One","level":1,"opening":"It was a bright cold day in April and more"},{"title":"X","level":3,"opening":"hi"}]}\n```'
    );
    expect(rows).toEqual([
      { title: "Chapter One", level: 1, opening: "It was a bright cold day in April and more" },
    ]);
  });

  it("returns empty on a bad reply", () => {
    expect(parseWindowChapters("not json")).toEqual([]);
    expect(parseWindowChapters('{"chapters":[]}')).toEqual([]);
  });
});

describe("locateOpeningWords", () => {
  it("finds an exact match", () => {
    expect(locateOpeningWords(BOOK, "The sun rose over the quiet village")).toBe(
      BOOK.indexOf("The sun rose over the quiet village")
    );
  });

  it("ignores whitespace, punctuation and case", () => {
    const at = locateOpeningWords(BOOK, "  THE sun, rose   over the QUIET village\nwhile BIRDS ");
    expect(at).toBe(BOOK.indexOf("The sun rose over the quiet village"));
  });

  it("fuzzy-matches a slightly mis-copied opening", () => {
    const opening = "It was a bright gold day in April and the clocks were striking";
    const at = locateOpeningWords(BOOK, opening);
    expect(at).toBe(BOOK.indexOf("It was a bright cold day in April"));
  });

  it("returns -1 when the opening is not there", () => {
    expect(locateOpeningWords(BOOK, "Zebra quantum xylophone fleet over Mars tonight")).toBe(-1);
    expect(locateOpeningWords(BOOK, "no")).toBe(-1);
  });

  it("searches forward from the cursor", () => {
    const repeated = `${BOOK}\n\n${BOOK}`;
    const first = repeated.indexOf("The sun rose");
    const second = repeated.indexOf("The sun rose", first + 1);
    expect(locateOpeningWords(repeated, "The sun rose over the quiet village", second)).toBe(
      second
    );
  });

  it("fuzzy needs enough words and overlap", () => {
    const cache = buildFoldedCache(BOOK);
    expect(fuzzyLocateOpening(cache, ["it", "was", "a"], 0)).toBe(-1);
    expect(
      fuzzyLocateOpening(cache, "zebra quantum xylophone fleet over mars tonight".split(" "), 0)
    ).toBe(-1);
  });
});

describe("snapChapterStart", () => {
  it("snaps to the title line above the opening", () => {
    const at = BOOK.indexOf("It was a bright cold day");
    const snapped = snapChapterStart(BOOK, at, "Chapter One");
    expect(snapped.charStart).toBe(BOOK.indexOf("Chapter One"));
    expect(snapped.match).toBe("Chapter One");
  });

  it("keeps the opening when no title line matches", () => {
    const text = ["A long opening paragraph that starts the book right away.", "Chapter One"].join(
      "\n\n"
    );
    const at = text.indexOf("A long opening");
    const snapped = snapChapterStart(text, at, "Chapter One");
    expect(snapped.charStart).toBe(0);
  });
});

describe("mergeLocatedChapters", () => {
  const entry = (title: string, charStart: number, windowIndex = 0): LocatedChapter => ({
    title,
    level: 1,
    opening: "some opening words here for the chapter",
    charStart,
    match: title,
    windowIndex,
  });

  it("sorts, dedupes overlap reports, and keeps distinct chapters", () => {
    const merged = mergeLocatedChapters([
      entry("Chapter Two", 500, 1),
      entry("Chapter One", 100, 0),
      entry("Chapter One", 120, 1),
      entry("Chapter Two", 900, 1),
    ]);
    expect(merged.map((chapter) => chapter.title)).toEqual([
      "Chapter One",
      "Chapter Two",
      "Chapter Two",
    ]);
    expect(merged.map((chapter) => chapter.charStart)).toEqual([100, 500, 900]);
  });
});

describe("resolveAiChapters", () => {
  const hint = { source: "heading-lines" as const, titles: [] };

  it("locates AI chapters with title snaps", async () => {
    const doc = await resolveAiChapters(BOOK, hint, {
      fetch: chatFetch([AI_REPLY]),
      apiKey: "or-key",
      host: "worker",
      minChars: 1,
    });
    expect(doc?.source).toBe("ai");
    expect(doc?.chapters.map((chapter) => chapter.title)).toEqual([
      "Chapter One",
      "Chapter Two",
    ]);
    expect(doc?.chapters[0]?.charStart).toBe(BOOK.indexOf("Chapter One"));
    expect(doc?.chapters[1]?.charStart).toBe(BOOK.indexOf("Chapter Two"));
  });

  it("nests sub-chapters under their chapter", async () => {
    const reply = JSON.stringify({
      chapters: [
        { title: "Part One", level: 1, opening: "It was a bright cold day in April and the clocks" },
        { title: "Early Days", level: 2, opening: "The sun rose over the quiet village while birds" },
      ],
    });
    const doc = await resolveAiChapters(BOOK, hint, {
      fetch: chatFetch([reply]),
      apiKey: "or-key",
      host: "node",
      minChars: 1,
    });
    expect(doc?.chapters).toHaveLength(1);
    expect(doc?.chapters[0]?.children?.map((child) => child.title)).toEqual(["Early Days"]);
  });

  it("drops unlocatable openings and returns null when none locate", async () => {
    const reply = JSON.stringify({
      chapters: [
        { title: "Chapter One", level: 1, opening: "It was a bright cold day in April and the clocks" },
        { title: "Lost", level: 1, opening: "Zebra quantum xylophone fleet over Mars tonight" },
      ],
    });
    const partial = await resolveAiChapters(BOOK, hint, {
      fetch: chatFetch([reply]),
      apiKey: "or-key",
      host: "worker",
      minChars: 1,
    });
    expect(partial?.chapters.map((chapter) => chapter.title)).toEqual(["Chapter One"]);

    const none = await resolveAiChapters(BOOK, hint, {
      fetch: chatFetch([
        JSON.stringify({
          chapters: [{ title: "Lost", level: 1, opening: "Zebra quantum xylophone over Mars" }],
        }),
      ]),
      apiKey: "or-key",
      host: "worker",
      minChars: 1,
    });
    expect(none).toBeNull();
  });

  it("skips tiny texts without calling the model", async () => {
    const fetch = chatFetch([AI_REPLY]);
    const calls = (fetch as unknown as { calls: () => number }).calls;
    const doc = await resolveAiChapters("Too short.", hint, {
      fetch,
      apiKey: "k",
      host: "worker",
    });
    expect(doc).toBeNull();
    expect(calls()).toBe(0);
  });

  it("falls back to null without a key, off host, or on failure", async () => {
    expect(await resolveAiChapters(BOOK, hint, { fetch: chatFetch([AI_REPLY]), host: "worker" })).toBeNull();
    process.env.OPENROUTER_API_KEY = "or-key";
    expect(
      await resolveAiChapters(BOOK, hint, { fetch: chatFetch([AI_REPLY]), host: "inline" })
    ).toBeNull();
    expect(
      await resolveAiChapters(BOOK, hint, { fetch: chatFetch([AI_REPLY]) })
    ).toBeNull();
    expect(
      await resolveAiChapters(BOOK, hint, { fetch: chatFetch(["not json"]), host: "worker" })
    ).toBeNull();
    expect(
      await resolveAiChapters(BOOK, hint, { fetch: failedFetch(), host: "worker" })
    ).toBeNull();
    expect(
      await resolveAiChapters(BOOK, hint, {
        fetch: chatFetch([null]),
        apiKey: "k",
        host: "worker",
      })
    ).toBeNull();
  });
});

describe("offset to section and time mapping", () => {
  it("times AI chapters from section starts and speakable offsets", () => {
    const sections = [
      { charStart: 0, charEnd: 100 },
      { charStart: 100, charEnd: 200 },
    ];
    const tree = [
      { title: "Chapter One", charStart: 0 },
      { title: "Chapter Two", charStart: 150 },
    ];
    const timed = timePlaybackTree(tree, sections, [0, 10], 20);
    expect(timed[0]?.startSeconds).toBe(0);
    // Mid-section offset without section text is a char fraction: 10 + (50/100) * 10.
    expect(timed[1]?.startSeconds).toBe(15);
    expect(timed[0]?.endSeconds).toBe(15);
    expect(timed[1]?.endSeconds).toBe(20);
  });

  it("times a mid-section heading from the speakable section text", () => {
    const body = `${"x ".repeat(200)}Chapter Two\n\nThe story continues here.`;
    const offset = body.indexOf("Chapter Two");
    const sections = [{ charStart: 0, charEnd: body.length, text: body }];
    const timed = timePlaybackTree(
      [{ title: "Chapter Two", charStart: offset }],
      sections,
      [5],
      60
    );
    const start = timed[0]?.startSeconds ?? -1;
    expect(start).toBeGreaterThan(5);
    expect(start).toBeLessThan(60);
  });
});

describe("resolveChaptersForBook", () => {
  const hint = { source: "heading-lines" as const, titles: [] };

  it("uses AI chapters on a worker host and skips the model otherwise", async () => {
    const fetch = chatFetch([AI_REPLY]);
    const calls = (fetch as unknown as { calls: () => number }).calls;
    const ai = await resolveChaptersForBook(BOOK, hint, {
      fetch,
      apiKey: "k",
      host: "worker",
      minChars: 1,
    });
    expect(ai.source).toBe("ai");
    expect(calls()).toBeGreaterThan(0);

    const plain = await resolveChaptersForBook(BOOK, hint);
    expect(plain.source).not.toBe("ai");
  });

  it("falls back to the heuristic outline when AI fails", async () => {
    const doc = await resolveChaptersForBook(BOOK, hint, {
      fetch: failedFetch(),
      apiKey: "k",
      host: "node",
      minChars: 1,
    });
    expect(doc.source).not.toBe("ai");
    expect(doc.chapters.length).toBeGreaterThan(0);
  });
});
