import { describe, expect, it } from "vitest";
import {
  joinWrappedLine,
  unwrapPdfLines,
  unwrapPdfPages,
} from "./pdf-line-unwrap";
import { normalizeExtractedText } from "./text-extraction";

describe("joinWrappedLine", () => {
  it("joins a lowercase continuation and drops the hyphen", () => {
    expect(joinWrappedLine("The com-", "puter was fast.")).toBe(
      "The computer was fast."
    );
  });

  it("keeps the hyphen when the next line is capitalized", () => {
    expect(joinWrappedLine("well-", "Known")).toBe("well-Known");
  });
});

describe("unwrapPdfLines", () => {
  it("does not collapse a heading into the following sentence", () => {
    const paras = unwrapPdfLines([
      "Chapter One",
      "The lamps were lit along the quay and the tide was turning.",
      "Chapter Two",
      "Night settled over the harbour and the boats were still.",
    ]);
    expect(paras[0]).toBe("Chapter One");
    expect(paras[1]).toMatch(/^The lamps were lit/);
    expect(paras).toContain("Chapter Two");
    expect(paras.join("\n")).not.toMatch(/Chapter One The lamps/);
    expect(paras.join("\n")).not.toMatch(/Chapter Two Night/);
  });

  it("drops a page-number line without gluing the neighbours into one word", () => {
    const paras = unwrapPdfLines([
      "The lamps were lit along the quay.",
      "Page 12",
      "The tide was turning before midnight.",
    ]);
    expect(paras.join("\n")).not.toMatch(/Page 12/);
    expect(paras.join(" ")).toMatch(/lamps were lit/);
    expect(paras.join(" ")).toMatch(/tide was turning/);
  });
});

describe("unwrapPdfPages", () => {
  it("joins a sentence that crosses a page and keeps the next heading", () => {
    const text = unwrapPdfPages([
      "Chapter One\nThe lamps were lit along the quay and the tide was",
      "turning slowly.\nChapter Two\nNight settled over the harbour and the boats were still.",
    ]);
    expect(text).toContain("Chapter One");
    expect(text).toContain(
      "The lamps were lit along the quay and the tide was turning slowly."
    );
    expect(text).toMatch(/Chapter Two\n\nNight settled/);
    expect(text).not.toMatch(/was\n\nturning/);
    expect(text).not.toMatch(/Chapter One The lamps/);
  });
});

describe("normalizeExtractedText line structure", () => {
  it("keeps chapter headings when the extract has only single newlines", () => {
    const input = [
      "Chapter One",
      "The lamps were lit along the quay and the tide was turning.",
      "Chapter Two",
      "Night settled over the harbour and the boats were still tonight.",
    ].join("\n");
    const text = normalizeExtractedText(input);
    expect(text).toMatch(/^Chapter One\n\n/);
    expect(text).toContain("\n\nChapter Two\n\n");
    expect(text).not.toMatch(/Chapter One The lamps/);
  });

  it("still joins hard-wrapped lines inside a blank-line paragraph", () => {
    const input =
      "First paragraph line one.\nStill first paragraph.\n\nSecond paragraph.";
    expect(normalizeExtractedText(input)).toBe(
      "First paragraph line one. Still first paragraph.\n\nSecond paragraph."
    );
  });
});
