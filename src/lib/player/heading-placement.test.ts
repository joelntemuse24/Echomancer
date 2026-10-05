import { describe, expect, it } from "vitest";
import { headingOffsetSeconds, headingParagraphStart } from "./heading-placement";

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
});
