import { describe, it, expect } from "vitest";
import { splitTextForTts } from "./split-text";

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

  it("hard-splits oversized segments", () => {
    const long = "a".repeat(100);
    const chunks = splitTextForTts(long, 30);
    expect(chunks.every((c) => c.length <= 30)).toBe(true);
    expect(chunks.join("").length).toBe(100);
  });
});
