import { describe, expect, it } from "vitest";
import { normalizeExtractedText } from "./text-extraction";

describe("normalizeExtractedText", () => {
  it("preserves paragraph breaks", () => {
    const input = "First paragraph line one.\nStill first paragraph.\n\nSecond paragraph.";
    expect(normalizeExtractedText(input)).toBe(
      "First paragraph line one. Still first paragraph.\n\nSecond paragraph."
    );
  });

  it("fixes hyphenation across line breaks", () => {
    const input = "The com-\nputer was fast.";
    expect(normalizeExtractedText(input)).toBe("The computer was fast.");
  });

  it("strips standalone page numbers", () => {
    const input = "Chapter start.\n\nPage 12 of 200\n\nNext paragraph.";
    expect(normalizeExtractedText(input)).toBe(
      "Chapter start.\n\nNext paragraph."
    );
  });

  it("strips centered page markers", () => {
    const input = "End of section.\n\n— 42 —\n\nNew section.";
    expect(normalizeExtractedText(input)).toBe(
      "End of section.\n\nNew section."
    );
  });

  it("collapses excess blank lines", () => {
    const input = "One.\n\n\n\nTwo.";
    expect(normalizeExtractedText(input)).toBe("One.\n\nTwo.");
  });
});