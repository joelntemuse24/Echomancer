import { describe, expect, it } from "vitest";
import {
  activeBlockIndex,
  buildReadAlongDocument,
  charIndexForPlayback,
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
