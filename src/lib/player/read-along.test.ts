import { describe, expect, it } from "vitest";
import {
  activeBlockIndex,
  buildReadAlongDocument,
  charIndexForPlayback,
  passageSeekForChar,
  sectionCharAtSeconds,
  sectionSecondsAtChar,
  sentenceSpans,
  sentenceStartInText,
} from "./read-along";

const BOOK = `Chapter One

The harbor was quiet after the rain.

She closed the ledger.

Chapter Two

We leave at dawn.`;

describe("buildReadAlongDocument", () => {
  it("turns extracted text into chapter headings and paragraphs", () => {
    const doc = buildReadAlongDocument({ contentText: BOOK });
    expect(doc.blocks.map((block) => [block.kind, block.text])).toEqual([
      ["chapter", "Chapter One"],
      ["paragraph", "The harbor was quiet after the rain."],
      ["paragraph", "She closed the ledger."],
      ["chapter", "Chapter Two"],
      ["paragraph", "We leave at dawn."],
    ]);
    expect(doc.sections).toEqual([]);
    expect(doc.charCount).toBe(BOOK.length);
  });

  it("prefers frozen sections and hides cue tags", () => {
    const doc = buildReadAlongDocument({
      contentText: "ignored",
      frozenSections: [
        {
          index: 0,
          text: "Chapter One\n\n[confident] The harbor was quiet. [break]",
          durationSeconds: 12,
        },
        {
          index: 1,
          text: "[emphasis] She closed the ledger.",
          durationSeconds: 8,
        },
      ],
    });
    expect(doc.blocks.map((block) => block.text).join(" ")).not.toMatch(/\[/);
    expect(doc.blocks[0]).toMatchObject({ kind: "chapter", text: "Chapter One", sectionIndex: 0 });
    expect(doc.blocks[1]).toMatchObject({
      text: "The harbor was quiet.",
      sectionIndex: 0,
    });
    expect(doc.blocks[2]).toMatchObject({
      text: "She closed the ledger.",
      sectionIndex: 1,
    });
    expect(doc.sections.map((section) => section.durationSeconds)).toEqual([12, 8]);
  });
});

describe("activeBlockIndex", () => {
  const doc = buildReadAlongDocument({ contentText: BOOK });

  it("follows a stream cursor into the matching paragraph", () => {
    const harbor = BOOK.indexOf("The harbor");
    expect(
      activeBlockIndex(doc, {
        mode: "stream",
        currentTime: 0,
        duration: 0,
        sectionIndex: null,
        streamCursor: harbor + 2,
      })
    ).toBe(1);
  });

  it("walks the full book in proportion to playback time", () => {
    const dawn = BOOK.indexOf("We leave");
    const fraction = (dawn + 1) / BOOK.length;
    expect(
      activeBlockIndex(doc, {
        mode: "full",
        currentTime: fraction * 100,
        duration: 100,
        sectionIndex: null,
        streamCursor: null,
      })
    ).toBe(4);
  });

  it("uses section durations when every section has one", () => {
    const timed = buildReadAlongDocument({
      frozenSections: [
        { index: 0, text: "Chapter One\n\nFirst paragraph here.", durationSeconds: 10 },
        { index: 1, text: "Second paragraph here.", durationSeconds: 10 },
      ],
    });
    expect(
      charIndexForPlayback(timed, {
        mode: "full",
        currentTime: 15,
        duration: 999,
        sectionIndex: null,
        streamCursor: null,
      })
    ).toBeGreaterThanOrEqual(timed.sections[1]!.charStart);
    expect(
      activeBlockIndex(timed, {
        mode: "section",
        currentTime: 0,
        duration: 10,
        sectionIndex: 1,
        streamCursor: null,
      })
    ).toBe(timed.blocks.findIndex((block) => block.sectionIndex === 1));
  });
});

describe("passageSeekForChar", () => {
  it("seeks a sentence from section clocks, and a paragraph when the click is at its start", () => {
    const doc = buildReadAlongDocument({
      frozenSections: [
        {
          index: 0,
          text: "The harbor was quiet. She closed the ledger.",
          durationSeconds: 10,
        },
        { index: 1, text: "We leave at dawn.", durationSeconds: 10 },
      ],
    });
    const paragraph = doc.blocks[0]!;
    const second = paragraph.text.indexOf("She closed");
    const at = paragraph.charStart + sentenceStartInText(paragraph.text, second + 2);
    const seek = passageSeekForChar(doc, at);
    expect(sentenceStartInText(paragraph.text, second + 2)).toBe(second);
    expect(seek.sectionIndex).toBe(0);
    expect(seek.sectionSeconds).toBeGreaterThan(0);
    expect(seek.sectionSeconds).toBeLessThan(10);
    expect(seek.fullSeconds).toBeCloseTo(seek.sectionSeconds!);
    const dawn = doc.blocks[1]!;
    const next = passageSeekForChar(doc, dawn.charStart);
    expect(next.sectionIndex).toBe(1);
    expect(next.fullSeconds).toBeCloseTo(10);
    expect(next.sectionSeconds).toBeCloseTo(0);
  });

  it("uses a fraction of the file when sections have no durations", () => {
    const doc = buildReadAlongDocument({ contentText: BOOK });
    const dawn = BOOK.indexOf("We leave");
    const seek = passageSeekForChar(doc, dawn);
    expect(seek.fullSeconds).toBeNull();
    expect(seek.fraction).toBeCloseTo(dawn / BOOK.length);
  });
});

describe("measured section clock", () => {
  const SECTIONS = [
    { index: 0, text: "Chapter One\n\nFirst paragraph here. Second sentence here.", durationSeconds: 30 },
    { index: 1, text: "Second chapter text. Another sentence follows it.", durationSeconds: 10 },
  ];
  // Hints sum to 40 but the finished file is 22s: measured starts win.
  const MEASURED = { sectionStarts: [0, 12], totalSeconds: 22 };

  function measuredDoc() {
    return buildReadAlongDocument({ frozenSections: SECTIONS, measuredStarts: MEASURED });
  }

  it("prefers measured starts over provider estimates", () => {
    const doc = measuredDoc();
    expect(doc.sections.map((section) => section.startSeconds)).toEqual([0, 12]);
    expect(doc.sections.map((section) => section.durationSeconds)).toEqual([12, 10]);
    // Hint math would put 15s in section 0 (15 < 30); the measured clock is in section 1.
    const char = charIndexForPlayback(doc, {
      mode: "full",
      currentTime: 15,
      duration: 22,
      sectionIndex: null,
      streamCursor: null,
    });
    expect(char).toBeGreaterThanOrEqual(doc.sections[1]!.charStart);
  });

  it("lands exactly on section boundaries", () => {
    const doc = measuredDoc();
    const at = charIndexForPlayback(doc, {
      mode: "full",
      currentTime: 12,
      duration: 22,
      sectionIndex: null,
      streamCursor: null,
    });
    expect(at).toBe(doc.sections[1]!.charStart);
    const before = charIndexForPlayback(doc, {
      mode: "full",
      currentTime: 11.9,
      duration: 22,
      sectionIndex: null,
      streamCursor: null,
    });
    expect(before).toBeLessThan(doc.sections[1]!.charStart);
  });

  it("round-trips seeks through the same clock", () => {
    const doc = measuredDoc();
    for (const time of [0, 5, 11.9, 12, 15, 21.9]) {
      const char = charIndexForPlayback(doc, {
        mode: "full",
        currentTime: time,
        duration: 22,
        sectionIndex: null,
        streamCursor: null,
      });
      const seek = passageSeekForChar(doc, char);
      // Sentence-start snapping never runs ahead of the audio, and the
      // mapped position is a fixed point of the same mapping.
      expect(seek.fullSeconds).toBeLessThanOrEqual(time + 0.001);
      expect(time - (seek.fullSeconds ?? 0)).toBeLessThan(7);
      const again = charIndexForPlayback(doc, {
        mode: "full",
        currentTime: seek.fullSeconds ?? 0,
        duration: 22,
        sectionIndex: null,
        streamCursor: null,
      });
      expect(again).toBe(char);
      const section = doc.sections.find((item) => item.index === seek.sectionIndex)!;
      expect(seek.fullSeconds).toBeCloseTo(
        (section.startSeconds ?? 0) + (seek.sectionSeconds ?? 0),
        5
      );
    }
  });

  it("maps per-section files on their own clock", () => {
    const doc = measuredDoc();
    // Section 1's own file is 5s long here, not its 10s full-file slice.
    const char = charIndexForPlayback(doc, {
      mode: "section",
      currentTime: 2.5,
      duration: 5,
      sectionIndex: 1,
      streamCursor: null,
    });
    const section = doc.sections[1]!;
    expect(char).toBeGreaterThanOrEqual(section.charStart);
    expect(char).toBeLessThan(section.charEnd);
    const seek = passageSeekForChar(doc, char);
    expect(seek.sectionIndex).toBe(1);
    expect(seek.sectionSeconds).toBeGreaterThan(0);
    expect(seek.sectionSeconds).toBeLessThan(5);
  });

  it("scales hint durations when no measured clock exists", () => {
    const doc = buildReadAlongDocument({ frozenSections: SECTIONS, totalSeconds: 20 });
    expect(doc.sections.map((section) => section.startSeconds)).toEqual([0, 15]);
    const char = charIndexForPlayback(doc, {
      mode: "full",
      currentTime: 16,
      duration: 20,
      sectionIndex: null,
      streamCursor: null,
    });
    expect(char).toBeGreaterThanOrEqual(doc.sections[1]!.charStart);
  });
});

describe("sentence timing", () => {
  it("does not split after abbreviations", () => {
    expect(sentenceSpans("Mr. Bennet waited. She left.")).toEqual([
      { start: 0, end: 18 },
      { start: 19, end: 28 },
    ]);
  });

  it("weights paragraph breaks as pauses, not speech", () => {
    const short = "Brief line here.";
    const long = `A much longer paragraph follows the short ones, carrying most of the section's words in a single block of narration that runs on without a pause.`;
    const section = [short, short, short, short, long].join("\n\n");
    const doc = buildReadAlongDocument({
      frozenSections: [{ index: 0, text: section, durationSeconds: 120 }],
    });
    const timed = doc.sections[0]!;
    expect(timed.sentences).toHaveLength(5);
    expect(timed.sentences.slice(0, 4).every((sentence) => sentence.pauseAfter > 0)).toBe(true);
    expect(timed.sentences[4]!.pauseAfter).toBe(0);
    // The four 0.7s paragraph pauses sit in the short-paragraph stretch, so
    // the pause-aware boundary differs from the raw-char fraction, and it
    // matches the pause model exactly: speech share of the remaining time
    // plus the pauses before it.
    const naive = (timed.sentences[4]!.start / section.length) * 120;
    const longStart = timed.charStart + timed.sentences[4]!.start;
    expect(section.slice(longStart - timed.charStart).startsWith("A much longer")).toBe(true);
    const back = sectionSecondsAtChar(timed, longStart, 120);
    const speechShort = short.length;
    const speechLong = long.replace(/\s+/g, " ").trim().length;
    const expected =
      ((4 * speechShort) / (4 * speechShort + speechLong)) * (120 - 4 * 0.7) + 4 * 0.7;
    expect(back).toBeCloseTo(expected, 1);
    expect(Math.abs(back - naive)).toBeGreaterThan(0.5);
    // ...and mapping that time forward lands back on the long paragraph.
    const at = sectionCharAtSeconds(timed, back, 120);
    expect(section.slice(at - timed.charStart).startsWith("A much longer")).toBe(true);
  });

  it("snaps within a section to sentence starts", () => {
    const doc = buildReadAlongDocument({
      frozenSections: [
        { index: 0, text: "The harbor was quiet. She closed the ledger.", durationSeconds: 10 },
      ],
    });
    const section = doc.sections[0]!;
    const second = sectionSecondsAtChar(section, section.charStart, 10);
    expect(second).toBe(0);
    const mid = sectionCharAtSeconds(section, 5, 10);
    const text = "The harbor was quiet. She closed the ledger.";
    expect(text.slice(mid - section.charStart)).toMatch(/^(The harbor|She closed)/);
  });
});
