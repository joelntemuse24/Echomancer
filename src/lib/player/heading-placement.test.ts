import { describe, expect, it } from "vitest";
import {
  HEADING_SNAP_CHARS,
  headingOffsetSeconds,
  headingParagraphStart,
} from "./heading-placement";

describe("headingOffsetSeconds", () => {
  it("snaps to the heading paragraph and skips unspoken links", () => {
    const junk = "https://example.com/very/long/path/that/is/not/spoken ";
    const text = `${junk.repeat(40)}Spoken.\n\nPart Three extra words\n\n${"word ".repeat(80)}`;
    const inside = text.indexOf("extra");
    const duration = 200;
    const raw = (inside / text.length) * duration;
    const placed = headingOffsetSeconds(text, inside, duration);
    expect(headingParagraphStart(text, inside)).toBe(text.indexOf("Part Three"));
    expect(placed).toBeLessThan(15);
    expect(raw).toBeGreaterThan(40);
    expect(placed).toBeLessThan(raw);
  });

  it("counts a heading pause and a soft tone instead of their tag characters", () => {
    const text = `[soft tone]\n\nHello.\n\n[long-break]\n\nPart Three\n\n${"a".repeat(80)}`;
    const at = text.indexOf("Part Three") + 4;
    const placed = headingOffsetSeconds(text, at, 100);
    expect(headingParagraphStart(text, at)).toBe(text.indexOf("Part Three"));
    const raw = (at / text.length) * 100;
    expect(placed).toBeGreaterThan(0.4);
    expect(placed).toBeLessThan(raw);
  });

  it("stays at the section start when the heading opens it", () => {
    expect(headingOffsetSeconds("Part One\n\nThe rest of the section.", 0, 40)).toBe(0);
  });

  it("keeps a topic phrase deep in a paragraph at its own offset", () => {
    const lead = "Opening paragraph.\n\n";
    const paragraph = `${"word ".repeat(100)}Topic phrase here ${"more ".repeat(100)}`;
    const text = lead + paragraph;
    const at = text.indexOf("Topic phrase");
    expect(at - headingParagraphStart(text, at)).toBeGreaterThan(HEADING_SNAP_CHARS);
    const placed = headingOffsetSeconds(text, at, 300);
    const paragraphStart = headingParagraphStart(text, at);
    const snapped = headingOffsetSeconds(text, paragraphStart, 300);
    expect(placed).toBeGreaterThan(snapped + 20);
  });

  it("snaps a heading within the first characters of its paragraph", () => {
    const text = `Opening paragraph.\n\nPart Three ${"word ".repeat(100)}`;
    const start = text.indexOf("Part Three");
    const atStart = headingOffsetSeconds(text, start, 300);
    expect(headingOffsetSeconds(text, start + HEADING_SNAP_CHARS, 300)).toBe(atStart);
    expect(headingOffsetSeconds(text, start + HEADING_SNAP_CHARS + 1, 300)).toBeGreaterThan(atStart);
  });
});
