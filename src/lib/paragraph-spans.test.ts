import { describe, expect, it } from "vitest";
import { paragraphSpans } from "./paragraph-spans";

describe("paragraphSpans", () => {
  it("keeps the offset of every paragraph", () => {
    const text = "One.\n\nTwo here.\n\nThree.";
    const spans = paragraphSpans(text);
    expect(spans.map((span) => span.text)).toEqual(["One.", "Two here.", "Three."]);
    for (const span of spans) {
      expect(text.slice(span.start, span.start + span.text.length)).toBe(span.text);
    }
  });

  it("treats a blank line with trailing spaces as one separator", () => {
    const spans = paragraphSpans("One.\n   \nTwo.");
    expect(spans.map((span) => span.text)).toEqual(["One.", "Two."]);
  });

  it("normalizes CRLF before splitting", () => {
    const spans = paragraphSpans("One.\r\n\r\nTwo.");
    expect(spans.map((span) => span.text)).toEqual(["One.", "Two."]);
  });

  it("returns the whole input as one span when there is no blank line", () => {
    const spans = paragraphSpans("Just one paragraph, no breaks here.");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.start).toBe(0);
  });
});
