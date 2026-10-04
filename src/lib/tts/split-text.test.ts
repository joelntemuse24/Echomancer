import { describe, it, expect } from "vitest";
import { playbackChaptersFromSections } from "@/lib/player/playback-chapters";
import {
  absorbSmallFanoutRemainder,
  hardMaxForTarget,
  packSpeakableSections,
  splitTextForTts,
} from "./split-text";
import { toSpeakableText } from "./speakable-text";
import {
  FIRST_SECTION_CHARS,
  FISH_FIRST_SECTION_CHARS,
  FISH_HARD_MAX_CHARS,
  FISH_TARGET_CHARS,
  MIN_SECTION_CHARS,
  hardMaxCharsForModel,
  maxCharsForModel,
} from "./section-size";

describe("splitTextForTts", () => {
  it("returns empty for blank input", () => {
    expect(splitTextForTts("", 500)).toEqual([]);
    expect(splitTextForTts("   ", 500)).toEqual([]);
  });

  it("keeps short text as one chunk", () => {
    expect(splitTextForTts("Hello world.", 500)).toEqual(["Hello world."]);
  });

  it("splits on paragraphs under max", () => {
    const text = "Para one.\n\nPara two.\n\nPara three.";
    const chunks = splitTextForTts(text, 20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(" ")).toContain("Para one");
    expect(chunks.join(" ")).toContain("Para three");
  });

  it("ends on the previous paragraph when the budget lands mid-block", () => {
    const a = "A".repeat(80);
    const b = "B".repeat(80);
    const c = "C".repeat(80);
    const chunks = splitTextForTts(`${a}\n\n${b}\n\n${c}`, 100);
    expect(chunks[0]).toBe(a);
    expect(chunks[0]).not.toContain("B");
    expect(chunks.join("\n\n")).toContain(b);
    expect(chunks.join("\n\n")).toContain(c);
  });

  it("runs a little past the target to finish a short first paragraph", () => {
    const stub = "Hi.";
    const rest = "The rest of the thought continues here and must stay attached.";
    const chunks = splitTextForTts(`${stub}\n\n${rest}`, 20);
    expect(chunks[0]).toContain(stub);
    expect(chunks[0]).toContain(rest);
  });

  it("does not start a new section on leftover page-number lines", () => {
    const chunks = splitTextForTts(
      "First page paragraph.\n\nPage 12\n\nSecond page paragraph.",
      500
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("First page paragraph.");
    expect(chunks[0]).toContain("Second page paragraph.");
    expect(chunks[0]).not.toMatch(/Page 12/);
  });

  it("treats a form-feed as layout, not a speech boundary", () => {
    const chunks = splitTextForTts("Page one words.\n\n\f\n\nPage two words.", 500);
    expect(chunks).toEqual(["Page one words.\n\nPage two words."]);
  });

  it("never packs a chapter heading with the previous chapter body", () => {
    const body1 = "The river was wide and the night was long enough to fill a paragraph. ".repeat(60);
    const body2 = "Dawn came over the ridge and the company moved on. ".repeat(60);
    const text = `Chapter 1\n\n${body1}\n\nChapter 2\n\n${body2}`;
    const packed = packSpeakableSections(text, 4000);
    expect(packed.length).toBeGreaterThanOrEqual(2);
    const firstWithTwo = packed.findIndex((s) => /Chapter 2/.test(s.text));
    expect(firstWithTwo).toBeGreaterThan(0);
    expect(packed[firstWithTwo]!.text).toMatch(/^Chapter 2/);
    expect(packed[firstWithTwo - 1]!.text).not.toContain("Chapter 2");
    expect(packed[firstWithTwo]!.chapterIndex).toBeGreaterThan(
      packed[firstWithTwo - 1]!.chapterIndex
    );
  });

  it("keeps a unique out-of-order chapter and the chapters after it", () => {
    const text = [
      "Chapter 3",
      "The duel is the subject of this paragraph and it keeps going onward for a while.",
      "Chapter 4",
      "The sacred follows the duel in this paragraph of the book itself tonight.",
      "Chapter 1",
      "The escalation returns only as a citation inside a later chapter of the book.",
      "Chapter 5",
      "Sorrow is the subject of this later paragraph in the book as it continues.",
    ].join("\n\n");
    const packed = packSpeakableSections(text, 4000);
    expect(playbackChaptersFromSections(packed).map((chapter) => chapter.title)).toEqual([
      "Chapter 3",
      "Chapter 4",
      "Chapter 1",
      "Chapter 5",
    ]);
    expect(packed.some((section) => /escalation returns/.test(section.text))).toBe(true);
  });

  it("keeps real chapters when a glued citation would otherwise become Chapter 3", () => {
    const spoken = toSpeakableText(
      [
        "Preface. Chapter 3 shows that the duel continues and the sacred follows after the rain.",
        "Chapter 1",
        "The escalation starts here and the paragraph is long enough to read aloud tonight.",
        "Chapter 2",
        "Clausewitz and the argument continue in a full paragraph of reading tonight.",
        "Chapter 3",
        "The duel is the subject of this paragraph and it keeps going onward tonight.",
        "Chapter 4",
        "The sacred follows the duel in this paragraph of the book itself tonight.",
      ].join("\n\n")
    );
    const packed = packSpeakableSections(spoken, 4000);
    expect(playbackChaptersFromSections(packed).map((chapter) => chapter.title)).toEqual([
      "Chapter 1",
      "Chapter 2",
      "Chapter 3",
      "Chapter 4",
    ]);
  });

  it("restarts chapter numbers in a new part and section numbers in a new chapter", () => {
    const text = [
      "Part One",
      "The first part opens with a paragraph long enough to be read aloud.",
      "Chapter 1",
      "Section 1",
      "The first section has a paragraph of its own in this part of the book.",
      "Chapter 2",
      "Section 1",
      "The next chapter starts its own first section with a full paragraph.",
      "Part Two",
      "Chapter 1",
      "The second part numbers its chapters from one again in a full paragraph.",
      "Chapter 2",
      "The second chapter of the second part continues in a full paragraph.",
    ].join("\n\n");
    expect(playbackChaptersFromSections(packSpeakableSections(text, 4000)).map((chapter) => chapter.title)).toEqual([
      "Part One",
      "Part One · Chapter 1",
      "Section 1",
      "Part One · Chapter 2",
      "Section 1",
      "Part Two",
      "Part Two · Chapter 1",
      "Part Two · Chapter 2",
    ]);
  });

  it("keeps hyphenated chapter numbers distinct", () => {
    const text = [
      "Chapter Twenty",
      "The twentieth chapter has a paragraph long enough to read aloud.",
      "Chapter Twenty-One",
      "The next chapter has a paragraph long enough to read aloud too.",
      "Chapter Twenty-Two",
      "The one after that has a paragraph long enough to read aloud as well.",
    ].join("\n\n");
    expect(playbackChaptersFromSections(packSpeakableSections(text, 4000)).map((chapter) => chapter.title)).toEqual([
      "Chapter Twenty",
      "Chapter Twenty-One",
      "Chapter Twenty-Two",
    ]);
  });

  it("uses a ~8k Fish target and keeps Edge near 4k", () => {
    expect(maxCharsForModel({ provider: "fish" })).toBe(FISH_TARGET_CHARS);
    expect(hardMaxCharsForModel({ provider: "fish" })).toBe(FISH_HARD_MAX_CHARS);
    expect(maxCharsForModel({ provider: "edge", catalogMax: 4000 })).toBe(4000);
    const para = "A clause of academic prose continues without a heading. ".repeat(80);
    const fish = packSpeakableSections(para, FISH_TARGET_CHARS, {
      hardMaxChars: FISH_HARD_MAX_CHARS,
      firstSectionMaxChars: FISH_FIRST_SECTION_CHARS,
    });
    expect(fish[0]!.text.length).toBeLessThanOrEqual(FISH_FIRST_SECTION_CHARS + 80);
    if (fish.length > 1) {
      expect(fish[1]!.text.length).toBeGreaterThan(FISH_FIRST_SECTION_CHARS);
      expect(fish[1]!.text.length).toBeLessThanOrEqual(FISH_HARD_MAX_CHARS);
    }
    const edge = packSpeakableSections(para, 4000);
    expect(edge.every((s) => s.text.length <= hardMaxForTarget(4000))).toBe(true);
  });

  it("hard-splits a single run that exceeds the hard ceiling", () => {
    const long = "a".repeat(100);
    const chunks = splitTextForTts(long, 30, { hardMaxChars: 30 });
    expect(chunks.every((c) => c.length <= 30)).toBe(true);
    expect(chunks.join("").length).toBe(100);
  });

  it("does not treat Mr. or Dr. as a sentence end when packing", () => {
    const para =
      "Mr. Darcy arrived at the door with a letter. Dr. Grant waited outside in the rain.";
    const chunks = splitTextForTts(para, 40, { hardMaxChars: 70 });
    expect(chunks.join(" ")).toContain("Mr. Darcy");
    expect(chunks.join(" ")).toContain("Dr. Grant");
    expect(chunks.every((c) => !/^Darcy\b/.test(c) && !/^Grant\b/.test(c))).toBe(
      true
    );
  });

  it("prefers sentence breaks inside an oversized paragraph", () => {
    const s1 = "First sentence is complete.";
    const s2 = "Second sentence is also complete.";
    const s3 = "Third sentence wraps the idea.";
    const para = `${s1} ${s2} ${s3}`;
    const chunks = splitTextForTts(para, 40, { hardMaxChars: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some((c) => c.includes("First sentence"))).toBe(true);
    expect(chunks.join(" ")).toContain("Third sentence");
  });
});

describe("absorbSmallFanoutRemainder", () => {
  it("folds a short same-chapter tail so the count is a multiple of 5", () => {
    const body = "The harbour stayed quiet while the crew kept the watch through the night. ";
    const sections = Array.from({ length: 6 }, (_, index) => ({
      index,
      text: index < 5 ? body.repeat(40) : body.repeat(8),
      chapterIndex: 0,
      chapterTitle: index === 0 ? "One" : null,
      charStart: 0,
      charEnd: 0,
      joinKind: "paragraph" as const,
    }));
    const folded = absorbSmallFanoutRemainder(sections, { fanout: 5, hardMaxChars: 9200 });
    expect(folded).toHaveLength(5);
    expect(folded[4]!.text).toContain(sections[5]!.text.trim().slice(0, 40));
    expect(Math.max(...folded.map((section) => section.text.length))).toBeLessThanOrEqual(9200);
  });

  it("leaves a chapter-start leftover on its own section", () => {
    const text = "A paragraph long enough to stand as its own section in the book.";
    const sections = Array.from({ length: 6 }, (_, index) => ({
      index,
      text,
      chapterIndex: index === 5 ? 1 : 0,
      chapterTitle: index === 5 ? "Next" : index === 0 ? "One" : null,
      charStart: index,
      charEnd: index + 1,
      joinKind: index === 5 ? ("chapter" as const) : ("paragraph" as const),
    }));
    expect(absorbSmallFanoutRemainder(sections, { fanout: 5, hardMaxChars: 9200 })).toHaveLength(6);
  });
});

describe("hardMaxForTarget", () => {
  it("allows slack past the target so we can reach a boundary", () => {
    expect(hardMaxForTarget(2000)).toBeGreaterThan(2000);
    expect(hardMaxForTarget(2000)).toBe(2500);
  });
});

describe("stored chapter outline (chapters.json)", () => {
  const body = (sentence: string) =>
    `${sentence} ${"The harbour stayed quiet and the crew kept the watch through the night. ".repeat(50)}`;

  it("forces section breaks where the outline matches, with the stored display title", () => {
    const text = ["1", body("The escalation opens."), "2", body("Clausewitz continues.")].join(
      "\n\n"
    );
    const packed = packSpeakableSections(text, 4000, {
      chapters: [
        { match: "1", title: "Chapter 1: The Escalation to Extremes" },
        { match: "2", title: "Chapter 2: Clausewitz and Hegel" },
      ],
    });
    const first = packed.find((section) => section.text.includes("The escalation opens"));
    const second = packed.find((section) => section.text.includes("Clausewitz continues"));
    expect(first?.chapterTitle).toBe("Chapter 1: The Escalation to Extremes");
    expect(second?.chapterTitle).toBe("Chapter 2: Clausewitz and Hegel");
    expect(second!.text).toMatch(/^2\n/);
    expect(first!.text).not.toContain("Clausewitz continues");
  });

  it("searches ahead when an outline entry is missing from the text", () => {
    const text = [
      "Chapter One",
      body("The first chapter opens."),
      "Chapter Three",
      body("The third chapter closes."),
    ].join("\n\n");
    const packed = packSpeakableSections(text, 4000, {
      chapters: [
        { match: "Chapter One", title: "Chapter One" },
        { match: "Chapter Two", title: "Chapter Two" },
        { match: "Chapter Three", title: "Chapter Three" },
      ],
    });
    const titles = packed
      .map((section) => section.chapterTitle)
      .filter((title): title is string => Boolean(title));
    expect(titles).toEqual(["Chapter One", "Chapter Three"]);
  });

  it("binds a contents table to the body headings, not the table", () => {
    const contents = ["CHAPTER I", "CHAPTER II", "CHAPTER III"].join("\n\n");
    const text = [
      "Contents",
      contents,
      "CHAPTER I",
      body("The first chapter of the novel begins."),
      "CHAPTER II",
      body("The second chapter continues the story."),
      "CHAPTER III",
      body("The third chapter closes the book."),
    ].join("\n\n");
    const packed = packSpeakableSections(text, 4000, {
      chapters: [
        { match: "CHAPTER I", title: "Chapter I" },
        { match: "CHAPTER II", title: "Chapter II" },
        { match: "CHAPTER III", title: "Chapter III" },
      ],
    });
    const playback = playbackChaptersFromSections(packed);
    expect(playback.map((chapter) => chapter.title)).toEqual([
      "Chapter I",
      "Chapter II",
      "Chapter III",
    ]);
    const spoken = packed.map((section) => section.text).join("\n\n");
    const begin = spoken.indexOf("The first chapter of the novel begins.");
    expect(spoken.lastIndexOf("CHAPTER I", begin)).toBeGreaterThan(spoken.indexOf("CHAPTER I"));
    expect(playback[0]!.startFraction).toBeGreaterThan(0);
    const third = packed.find((section) =>
      section.text.includes("The third chapter closes the book.")
    );
    expect(
      [third?.chapterTitle, ...(third?.chapterMarks ?? []).map((mark) => mark.title)]
    ).toContain("Chapter III");
  });

  it("does not treat Chapter III as Chapter II", () => {
    const text = [
      "Chapter II",
      body("The second chapter opens."),
      "Chapter III",
      body("The third chapter opens."),
    ].join("\n\n");
    const packed = packSpeakableSections(text, 4000, {
      chapters: [
        { match: "Chapter II", title: "Chapter II" },
        { match: "Chapter III", title: "Chapter III" },
      ],
    });
    expect(packed.find((section) => section.text.includes("The third chapter opens"))?.chapterTitle).toBe(
      "Chapter III"
    );
  });

  it("falls back to heading detection when under half the outline matches", () => {
    const text = [
      "Chapter One",
      body("The first chapter opens."),
      "Chapter Two",
      body("The second chapter closes."),
    ].join("\n\n");
    const packed = packSpeakableSections(text, 4000, {
      chapters: [
        { match: "Chapter One", title: "Stored One" },
        { match: "Missing Two", title: "Stored Two" },
        { match: "Missing Three", title: "Stored Three" },
        { match: "Missing Four", title: "Stored Four" },
      ],
    });
    const titles = packed
      .map((section) => section.chapterTitle)
      .filter((title): title is string => Boolean(title));
    expect(titles).toEqual(["Chapter One", "Chapter Two"]);
  });
});

describe("front matter and minimum section size", () => {
  const sentence = (text: string) =>
    `${text} The harbour stayed quiet and the crew kept the watch through the night.`;

  function frontMatterBook(): string {
    const preface = sentence("The preface explains how this history was written.").repeat(30);
    const part = sentence("The first part opens on the harbour before the fighting starts.");
    const chapter = sentence("The first chapter begins with the army still in camp.").repeat(40);
    const contents = Array.from({ length: 360 }, (_, i) => {
      const n = (i % 28) + 1;
      return `CHAPTER ${n} . . . . . . . . ${i + 3}`;
    });
    return [
      "A History",
      "Of The",
      "American",
      "People",
      "First U.S. Edition",
      "Copyright © 1999 by Example Press. All rights reserved.",
      "Library of Congress Cataloging-in-Publication Data",
      "ISBN 978-0-000-00000-0",
      "Printed in the United States of America.",
      "5 The",
      "Too Bad!''",
      "Preface",
      preface,
      "Part One",
      part,
      "Chapter I",
      chapter,
      "Contents",
      ...contents,
      "Chapter II",
      sentence("The second chapter follows the army through the winter campaign.").repeat(40),
    ].join("\n\n");
  }

  it("packs a title page into a fast first section and keeps real chapters", () => {
    const packed = packSpeakableSections(frontMatterBook(), 4000);
    const lengths = packed.map((section) => section.text.length);
    expect(lengths.filter((length) => length < 500)).toEqual([]);
    expect(lengths[0]).toBeGreaterThanOrEqual(FIRST_SECTION_CHARS - 150);
    expect(lengths[0]).toBeLessThanOrEqual(FIRST_SECTION_CHARS + 160);
    expect(Math.max(...lengths)).toBeGreaterThan(MIN_SECTION_CHARS);

    const spoken = packed.map((section) => section.text).join("\n");
    expect(spoken).not.toMatch(/ISBN/);
    expect(spoken).not.toMatch(/All rights reserved/);
    expect(spoken).not.toMatch(/Library of Congress/);
    expect(spoken).not.toMatch(/First U\.S\. Edition/);
    expect(spoken).toContain("Preface");
    expect(spoken).toContain("The preface explains");

    const titles = playbackChaptersFromSections(packed).map((chapter) => chapter.title);
    expect(titles[0]).toMatch(/Preface/i);
    expect(titles).toContain("Part One");
    expect(titles.some((title) => /chapter i\b/i.test(title))).toBe(true);
    expect(titles.some((title) => /chapter ii\b/i.test(title))).toBe(true);
    expect(titles.some((title) => /isbn|edition|people|^of the$|^5 the$/i.test(title))).toBe(false);
    expect(titles.filter((title) => /chapter/i.test(title)).length).toBeLessThan(8);
    const preface = playbackChaptersFromSections(packed)[0]!;
    expect(preface.startFraction).toBeGreaterThan(0);
  });

  it("keeps the copyright page when TTS_SKIP_FRONT_MATTER=0", () => {
    const previous = process.env.TTS_SKIP_FRONT_MATTER;
    process.env.TTS_SKIP_FRONT_MATTER = "0";
    try {
      const text = [
        "ISBN 978-0-000-00000-0",
        "Preface",
        sentence("The preface explains how this history was written."),
      ].join("\n\n");
      const spoken = packSpeakableSections(text, 4000)
        .map((section) => section.text)
        .join("\n");
      expect(spoken).toContain("ISBN 978-0-000-00000-0");
    } finally {
      if (previous === undefined) delete process.env.TTS_SKIP_FRONT_MATTER;
      else process.env.TTS_SKIP_FRONT_MATTER = previous;
    }
  });

  it("ends the first section on a sentence in the Alice opening", () => {
    const alice = [
      "Alice was beginning to get very tired of sitting by her sister on the bank, and of having nothing to do: once or twice she had peeped into the book her sister was reading, but it had no pictures or conversations in it, “and what is the use of a book,” thought Alice “without pictures or conversations?”",
      "So she was considering in her own mind (as well as she could, for the hot day made her feel very sleepy and stupid), whether the pleasure of making a daisy-chain would be worth the trouble of getting up and picking the daisies, when suddenly a White Rabbit with pink eyes ran close by her.",
      "There was nothing so very remarkable in that; nor did Alice think it so very much out of the way to hear the Rabbit say to itself, “Oh dear! Oh dear! I shall be late!” (when she thought it over afterwards, it occurred to her that she ought to have wondered at this, but at the time it all seemed quite natural); but when the Rabbit actually took a watch out of its waistcoat-pocket, and looked at it, and then hurried on, Alice started to her feet, for it flashed across her mind that she had never before seen a rabbit with either a waistcoat-pocket, or a watch to take out of it, and burning with curiosity, she ran across the field after it, and fortunately was just in time to see it pop down a large rabbit-hole under the hedge.",
    ].join("\n\n");
    const packed = packSpeakableSections(alice, 4000);
    const spoken = packed.map((section) => section.text).join("\n\n");
    expect(spoken).toContain("thought it over afterwards");
    expect(packed[0]!.text.length).toBeGreaterThan(500);
    expect(packed[0]!.text.trim()).toMatch(/[.!?]["\u201d\u2019]?\s*$/);
    for (let i = 0; i < packed.length - 1; i++) {
      const left = packed[i]!.text.trimEnd();
      const right = packed[i + 1]!.text.trimStart();
      expect(left.endsWith("over") && right.startsWith("afterwards")).toBe(false);
    }
  });

  it("drops a rights-and-imprint paragraph that looks like prose", () => {
    const notice =
      "All rights reserved. Printed in the United States of America. No part of this book may be used or reproduced in any manner whatsoever without written permission except in the case of brief quotations embodied in critical articles and reviews.";
    expect(notice.length).toBeGreaterThan(240);
    const prose = sentence("The preface explains how this history was written.");
    const spoken = packSpeakableSections([notice, prose].join("\n\n"), 4000)
      .map((section) => section.text)
      .join("\n");
    expect(spoken).not.toMatch(/All rights reserved/);
    expect(spoken).not.toMatch(/Printed in the United States/);
    expect(spoken).toContain("The preface explains");

    const discussion =
      "The author discusses copyright at length in this opening paragraph of the essay and explains why the statute still matters today to every reader who picks the book up.";
    const kept = packSpeakableSections(discussion, 4000)
      .map((section) => section.text)
      .join("\n");
    expect(kept).toContain("discusses copyright");
  });

  it("does not close a short section on a heading, and does close a long one", () => {
    const short = sentence("A short chapter stays with its neighbour.");
    const merged = packSpeakableSections(
      ["Chapter 1", short, "Chapter 2", short].join("\n\n"),
      4000
    );
    expect(merged).toHaveLength(1);
    const titles = playbackChaptersFromSections(merged).map((chapter) => chapter.title);
    expect(titles).toEqual(["Chapter 1", "Chapter 2"]);
    expect(playbackChaptersFromSections(merged)[1]!.startFraction).toBeGreaterThan(0);

    const para = sentence("The river was wide and the night was long.").repeat(18);
    const long = [para, para, para].join("\n\n");
    const split = packSpeakableSections(
      ["Chapter 1", long, "Chapter 2", long].join("\n\n"),
      4000
    );
    const chapter2 = split.find((section) => section.text.startsWith("Chapter 2"));
    expect(chapter2).toBeTruthy();
    expect(chapter2!.text).not.toContain("Chapter 1");
  });
});
