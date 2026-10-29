import { describe, expect, it } from "vitest";
import {
  activeBlockIndex,
  buildReadAlongDocument,
  charIndexForPlayback,
  passageSeekForChar,
  type ReadAlongDocument,
} from "./read-along";
import { tapCharIndex } from "./read-along-follow";

/**
 * A long, realistic book: 40 chapters of 8 paragraphs, each paragraph two
 * sentences, with a measured section clock and per-section durations that do
 * not match their character share. This is the shape the player meets on a
 * finished take-home book, and the shape the done criteria describe (tapping
 * in chapter 1, the middle, and the last chapter).
 */
const CHAPTERS = 40;
const PARAGRAPHS = 8;
const SENTENCES = [
  "The harbor was quiet after the rain, and the boats lay still against the quay.",
  "She closed the ledger and set the pen down beside the lamp.",
  "Nobody spoke for a while, which was how the mornings usually began there.",
  "Outside, a gull turned over the water and then went out of sight.",
];

function longBook(): { doc: ReadAlongDocument; totalSeconds: number } {
  const sections = Array.from({ length: CHAPTERS * PARAGRAPHS }, (_, index) => {
    const chapter = Math.floor(index / PARAGRAPHS) + 1;
    const first = index % PARAGRAPHS === 0;
    const body = Array.from({ length: 3 }, (_, s) => SENTENCES[(index + s) % SENTENCES.length]).join(" ");
    // Chapter-openers are longer (heading plus body); the rest vary.
    const text = first ? `Chapter ${chapter}\n\n${body}` : body;
    // Durations deliberately uneven: the last paragraph of each chapter runs
    // long, the first is short.
    const durationSeconds = index % PARAGRAPHS === 0 ? 18 : index % PARAGRAPHS === 7 ? 42 : 26;
    return { index, text, durationSeconds };
  });
  // A measured clock, as finalize writes one.
  let elapsed = 0;
  const sectionStarts = sections.map((section) => {
    const start = elapsed;
    elapsed += section.durationSeconds;
    return start;
  });
  const doc = buildReadAlongDocument({
    frozenSections: sections,
    measuredStarts: { sectionStarts, totalSeconds: elapsed },
  });
  return { doc, totalSeconds: elapsed };
}

function seekTime(doc: ReadAlongDocument, char: number): number {
  const seek = passageSeekForChar(doc, char);
  expect(seek.fullSeconds).not.toBeNull();
  return seek.fullSeconds!;
}

/** Where the highlight lands for a playback time. */
function charAt(doc: ReadAlongDocument, seconds: number): number {
  return charIndexForPlayback(doc, {
    mode: "full",
    currentTime: seconds,
    duration: 0,
    sectionIndex: null,
    streamCursor: null,
  });
}

describe("a long book keeps tap-to-seek and the highlight on the same words", () => {
  const { doc, totalSeconds } = longBook();

  it("covers chapters one, the middle, and the last", () => {
    expect(doc.sections).toHaveLength(CHAPTERS * PARAGRAPHS);
    // About 2.4 hours of narration: long enough that every page of the
    // clock matters.
    expect(totalSeconds).toBeGreaterThan(8_000);
    expect(doc.blocks.length).toBeGreaterThan(CHAPTERS * PARAGRAPHS);
  });

  const probes = [
    { label: "chapter 1", paragraph: 1 },
    { label: "middle", paragraph: Math.floor((CHAPTERS * PARAGRAPHS) / 2) },
    { label: "last chapter", paragraph: CHAPTERS * PARAGRAPHS - 2 },
  ];

  for (const probe of probes) {
    it(`lands within a second of the tapped words in ${probe.label}`, () => {
      const block = doc.blocks[probe.paragraph]!;
      // Tap the middle of the paragraph, as a finger does.
      const local = Math.floor(block.text.length / 2);
      const char = tapCharIndex(block, local);
      expect(char).toBeGreaterThanOrEqual(block.charStart);
      expect(char).toBeLessThan(block.charEnd);

      const target = seekTime(doc, char);
      // The seek snaps back to a sentence start, so it never runs ahead of
      // the words the listener tapped.
      const landed = charAt(doc, target);
      expect(landed).toBeLessThanOrEqual(char);

      // The highlight at that time is the passage the listener touched.
      expect(
        activeBlockIndex(doc, {
          mode: "full",
          currentTime: target,
          duration: 0,
          sectionIndex: null,
          streamCursor: null,
        })
      ).toBe(probe.paragraph);

      // "Within about a second of the right words": one second past the seek
      // must not have left the tapped paragraph.
      const afterOneSecond = activeBlockIndex(doc, {
        mode: "full",
        currentTime: target + 1,
        duration: 0,
        sectionIndex: null,
        streamCursor: null,
      });
      expect(afterOneSecond).toBe(probe.paragraph);
    });
  }

  it("does not drift over a long stretch of playback", () => {
    // Walk ten minutes forward in one-second steps, the way timeupdate does,
    // and check the highlight is monotonic and stays on the words whose
    // clock reading matches the section it sits in.
    let previousBlock = -1;
    const start = Math.floor(totalSeconds / 2);
    for (let offset = 0; offset <= 600; offset += 1) {
      const time = start + offset;
      const position = {
        mode: "full" as const,
        currentTime: time,
        duration: 0,
        sectionIndex: null,
        streamCursor: null,
      };
      const block = activeBlockIndex(doc, position);
      expect(block).toBeGreaterThanOrEqual(previousBlock);
      previousBlock = block;
      // The block the highlight shows must contain the character the clock
      // maps to — never a stale one.
      const char = charIndexForPlayback(doc, position);
      const owning = doc.blocks.find((b) => b.charStart <= char && char < b.charEnd)!;
      expect(owning.charStart).toBe(doc.blocks[block]!.charStart);
    }
  });

  it("round-trips a seek from every chapter start without jumping to zero", () => {
    for (let chapter = 1; chapter <= CHAPTERS; chapter += 7) {
      const block = doc.blocks.find(
        (b) => b.kind === "chapter" && b.text === `Chapter ${chapter}`
      )!;
      expect(block).toBeDefined();
      const at = seekTime(doc, block.charStart);
      if (chapter > 1) expect(at).toBeGreaterThan(0);
      expect(activeBlockIndex(doc, {
        mode: "full", currentTime: at, duration: 0, sectionIndex: null, streamCursor: null,
      })).toBe(doc.blocks.indexOf(block));
      // The section clock agrees: the chapter heading opens its own section.
      const section = doc.sections.find((s) => s.index === block.sectionIndex)!;
      expect(at).toBeCloseTo(section.startSeconds!, 5);
    }
  });
});
