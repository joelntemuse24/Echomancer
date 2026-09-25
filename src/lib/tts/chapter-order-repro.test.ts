import { describe, expect, it } from "vitest";
import { playbackChaptersFromSections } from "@/lib/player/playback-chapters";
import { deterministicPrepass } from "./listen-prep";
import { packSpeakableSections } from "./split-text";
import { toSpeakableText } from "./speakable-text";

function playerChapters(raw: string): string[] {
  const spoken = toSpeakableText(deterministicPrepass(raw));
  return playbackChaptersFromSections(packSpeakableSections(spoken, 4000)).map(
    (chapter) => chapter.title
  );
}

function packedText(raw: string): string {
  const spoken = toSpeakableText(deterministicPrepass(raw));
  return packSpeakableSections(spoken, 4000)
    .map((section) => section.text)
    .join("\n\n");
}

const prose = (sentence: string) =>
  `${sentence} The harbour stayed quiet and the crew kept the watch through the night.`;

describe("chapter detection regressions", () => {
  it("lets a later chapter with a body replace a contents entry of the same number", () => {
    const text = [
      "Contents",
      "Chapter 1: The Pier",
      "Chapter 2: The Storm",
      "Chapter 3: The Return",
      "Chapter 1: The Pier",
      prose("The pier was empty when the boat came in."),
      "Chapter 2: The Storm",
      prose("The storm held the crew together on the open water."),
      "Chapter 3: The Return",
      prose("The return brought the boat back into the harbour."),
    ].join("\n\n");
    expect(playerChapters(text)).toEqual([
      "Chapter 1: The Pier",
      "Chapter 2: The Storm",
      "Chapter 3: The Return",
    ]);
    const spoken = toSpeakableText(deterministicPrepass(text));
    const packed = packSpeakableSections(spoken, 4000);
    const pier = packed.find((section) => section.text.includes("The pier was empty"));
    const storm = packed.find((section) => section.text.includes("The storm held the crew"));
    const back = packed.find((section) => section.text.includes("The return brought the boat"));
    expect(pier?.chapterTitle).toBe("Chapter 1: The Pier");
    expect(storm?.chapterTitle).toBe("Chapter 2: The Storm");
    expect(back?.chapterTitle).toBe("Chapter 3: The Return");
    expect(pier!.text.indexOf("The pier was empty")).toBeGreaterThan(
      pier!.text.lastIndexOf("Chapter 1: The Pier")
    );
  });

  it("restarts numbering on Book and Volume", () => {
    const books = [
      "BOOK I",
      "CHAPTER I",
      prose("The first book opens on the pier."),
      "CHAPTER II",
      prose("The first book continues through the storm."),
      "BOOK II",
      "CHAPTER I",
      prose("The second book opens on the return."),
      "CHAPTER II",
      prose("The second book closes the harbour."),
    ].join("\n\n");
    expect(playerChapters(books)).toEqual([
      "Chapter I",
      "Chapter Ii",
      "Chapter I",
      "Chapter Ii",
    ]);

    const volumes = [
      "Volume One",
      "Chapter One",
      prose("Volume one begins with the pier."),
      "Chapter Two",
      prose("Volume one continues with the storm."),
      "Volume Two",
      "Chapter One",
      prose("Volume two begins with the return."),
      "Chapter Two",
      prose("Volume two closes the harbour."),
    ].join("\n\n");
    expect(playerChapters(volumes)).toEqual([
      "Chapter One",
      "Chapter Two",
      "Chapter One",
      "Chapter Two",
    ]);

    const bookWords = [
      "Book One",
      "Chapter 1",
      prose("Book one begins with the pier."),
      "Chapter 2",
      prose("Book one continues with the storm."),
      "Book Two",
      "Chapter 1",
      prose("Book two begins with the return."),
      "Chapter 2",
      prose("Book two closes the harbour."),
    ].join("\n\n");
    expect(playerChapters(bookWords)).toEqual([
      "Chapter 1",
      "Chapter 2",
      "Chapter 1",
      "Chapter 2",
    ]);
  });

  it("restarts numbering when a story title is followed by Chapter One", () => {
    const text = [
      "The Lighthouse Keeper",
      "Chapter One",
      prose("The keeper lit the lamp above the pier."),
      "Chapter Two",
      prose("The keeper watched the storm from the gallery."),
      "Salt and Iron",
      "Chapter One",
      prose("The second story opens in the foundry."),
      "Chapter Two",
      prose("The second story ends on the road home."),
    ].join("\n\n");
    expect(playerChapters(text)).toEqual([
      "Chapter One",
      "Chapter Two",
      "Chapter One",
      "Chapter Two",
    ]);

    const caps = [
      "THE LIGHTHOUSE KEEPER",
      "CHAPTER ONE",
      prose("The keeper lit the lamp above the pier."),
      "CHAPTER TWO",
      prose("The keeper watched the storm from the gallery."),
      "SALT AND IRON",
      "CHAPTER ONE",
      prose("The second story opens in the foundry."),
      "CHAPTER TWO",
      prose("The second story ends on the road home."),
    ].join("\n\n");
    expect(playerChapters(caps)).toEqual([
      "Chapter One",
      "Chapter Two",
      "Chapter One",
      "Chapter Two",
    ]);
  });

  it("keeps titles that contain Mr. Mrs. Dr. and St.", () => {
    const text = [
      "Chapter 6. Mr. Darcy Proposes",
      prose("Mr. Darcy spoke at the pier."),
      "Chapter 7: Dr. Jekyll Returns",
      prose("Dr. Jekyll came back with the storm."),
      "Chapter 10: St. Ives",
      prose("St. Ives held the harbour at the end."),
      "CHAPTER XII. MR. COLLINS",
      prose("Mr. Collins arrived after the return."),
    ].join("\n\n");
    expect(playerChapters(text)).toEqual([
      "Chapter 6. Mr. Darcy Proposes",
      "Chapter 7: Dr. Jekyll Returns",
      "Chapter 10: St. Ives",
      "Chapter Xii. Mr. Collins",
    ]);
  });

  it("rejects intro summaries and an over-long chapter sentence", () => {
    const summary = [
      "Chapter 2, “The Storm,” describes how the crew stays together.",
      "Chapter 3, “The Return,” shows the harbour in the end.",
      "Chapter 1: The Pier",
      prose("The pier was empty when the boat came in."),
      "Chapter 2: The Storm",
      prose("The storm held the crew together on the open water."),
      "Chapter 3: The Return",
      prose("The return brought the boat back into the harbour."),
    ].join("\n\n");
    expect(playerChapters(summary)).toEqual([
      "Chapter 1: The Pier",
      "Chapter 2: The Storm",
      "Chapter 3: The Return",
    ]);

    const long =
      "Chapter 2: The Storm Tells How The Crew Held Together Through The Night At Sea Now.";
    expect(long.length).toBe(83);
    const titled = [
      long,
      "Chapter 1: The Pier",
      prose("The pier was empty when the boat came in."),
      "Chapter 2: The Storm",
      prose("The storm held the crew together on the open water."),
    ].join("\n\n");
    expect(playerChapters(titled)).toEqual(["Chapter 1: The Pier", "Chapter 2: The Storm"]);
    expect(packedText(titled)).toContain(long);
  });

  it("reads sixty through hundred and leaves an unparsable chapter line unnumbered", () => {
    const text = [
      "Chapter the Last",
      prose("A closing note sits before the numbered chapters."),
      "Chapter Fifty-Nine",
      prose("Fifty-nine opens on the pier."),
      "Chapter Sixty",
      prose("Sixty holds the crew in the storm."),
      "Chapter Sixty-One",
      prose("Sixty-one brings the boat home."),
      "Chapter Hundred",
      prose("A hundred closes the harbour."),
    ].join("\n\n");
    expect(playerChapters(text)).toEqual([
      "Chapter the Last",
      "Chapter Fifty-Nine",
      "Chapter Sixty",
      "Chapter Sixty-One",
      "Chapter Hundred",
    ]);
  });

  it("treats a lowercase continuation as a broken sentence and still accepts the next number", () => {
    const forward = [
      "Chapter 8",
      "of this book returns to the emperor after the duel.",
      "Chapter 1",
      prose("The escalation starts on the pier."),
      "Chapter 2",
      prose("Clausewitz and the argument continue."),
      "Chapter 3",
      prose("The duel is the subject of this chapter."),
      "Chapter 8",
      prose("The pope and the emperor close the book."),
    ].join("\n\n");
    expect(playerChapters(forward)).toEqual([
      "Chapter 1",
      "Chapter 2",
      "Chapter 3",
      "Chapter 8",
    ]);

    const stray = [
      "Chapter 1",
      prose("The first chapter opens on the pier."),
      "Chapter 12",
      "is where the diagram appears in the margin of the page.",
      "Chapter 2",
      prose("The second chapter holds the storm."),
      "Chapter 3",
      prose("The third chapter brings the return."),
    ].join("\n\n");
    expect(playerChapters(stray)).toEqual(["Chapter 1", "Chapter 2", "Chapter 3"]);

    const outlier = [
      "Chapter 1",
      prose("The first chapter opens on the pier."),
      "Chapter 12",
      "The diagram sits in a later appendix of this book.",
      "Chapter 2",
      prose("The second chapter holds the storm."),
      "Chapter 3",
      prose("The third chapter brings the return."),
    ].join("\n\n");
    expect(playerChapters(outlier)).toEqual([
      "Chapter 1",
      "Chapter 12",
      "Chapter 2",
      "Chapter 3",
    ]);
  });

  it("keeps Battling-style openings when the file has no page numbers", () => {
    const text = [
      "Chapter 1",
      "of the opening argument returns only as a citation in the preface.",
      "Chapter 1. The Escalation to Extremes",
      prose("The escalation starts here in the first chapter."),
      "Chapter 2. Clausewitz and Hegel",
      prose("Clausewitz and Hegel continue the argument."),
      "Chapter 3. Duel and Reciprocity",
      prose("The duel is the subject of this chapter."),
      "Chapter 4: The Duel and the Sacred",
      prose("The sacred follows the duel in this chapter."),
      "Chapter 8",
      "of this book returns to the pope and the emperor.",
      "Chapter 5. Hölderlin's Sorrow",
      prose("Sorrow is the subject of this later chapter."),
      "Chapter 6. Clausewitz and Napoleon",
      prose("Napoleon enters the argument in this chapter."),
      "Chapter 7. France and Germany",
      prose("France and Germany close the middle of the book."),
      "Chapter 8. The Pope and the Emperor",
      prose("The pope and the emperor close the book."),
    ].join("\n\n");
    expect(playerChapters(text)).toEqual([
      "Chapter 1. The Escalation to Extremes",
      "Chapter 2. Clausewitz and Hegel",
      "Chapter 3. Duel and Reciprocity",
      "Chapter 4: The Duel and the Sacred",
      "Chapter 5. Hölderlin's Sorrow",
      "Chapter 6. Clausewitz and Napoleon",
      "Chapter 7. France and Germany",
      "Chapter 8. The Pope and the Emperor",
    ]);
  });

  it("drops junk headings that are not chapter titles", () => {
    const text = [
      "30 When",
      "the tide turned the boats were still along the quay.",
      "Chapter C",
      "Chapter D",
      "Chapter M",
      "Chapter 1. The Escalation to Extremes",
      prose("The escalation starts here in the first chapter."),
    ].join("\n\n");
    expect(playerChapters(text)).toEqual(["Chapter 1. The Escalation to Extremes"]);
    expect(packedText(text)).toContain("30 When");
  });
});
