import { describe, it, expect } from "vitest";
import { playbackChaptersFromSections } from "@/lib/player/playback-chapters";
import { hardMaxForTarget, packSpeakableSections, splitTextForTts } from "./split-text";
import { toSpeakableText } from "./speakable-text";
import {
  FISH_FIRST_SECTION_CHARS,
  FISH_HARD_MAX_CHARS,
  FISH_TARGET_CHARS,
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
    const body1 = "The river was wide and the night was long enough to fill a paragraph. ".repeat(4);
    const body2 = "Dawn came over the ridge and the company moved on. ".repeat(4);
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

  it("does not open a new chapter when a later paragraph cites an earlier one", () => {
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
      "Chapter 1",
      "Section 1",
      "Chapter 2",
      "Section 1",
      "Part Two",
      "Chapter 1",
      "Chapter 2",
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

describe("hardMaxForTarget", () => {
  it("allows slack past the target so we can reach a boundary", () => {
    expect(hardMaxForTarget(2000)).toBeGreaterThan(2000);
    expect(hardMaxForTarget(2000)).toBe(2500);
  });
});
