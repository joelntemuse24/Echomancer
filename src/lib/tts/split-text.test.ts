import { describe, it, expect } from "vitest";
import { hardMaxForTarget, splitTextForTts } from "./split-text";

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

  it("starts a new section on a page break even under budget", () => {
    const chunks = splitTextForTts(
      "First page paragraph.\n\nPage 12\n\nSecond page paragraph.",
      500
    );
    expect(chunks).toEqual(["First page paragraph.", "Second page paragraph."]);
  });

  it("treats a form-feed as a page break", () => {
    const chunks = splitTextForTts("Page one words.\n\n\f\n\nPage two words.", 500);
    expect(chunks).toEqual(["Page one words.", "Page two words."]);
  });

  it("hard-splits a single run that exceeds the hard ceiling", () => {
    const long = "a".repeat(100);
    const chunks = splitTextForTts(long, 30, { hardMaxChars: 30 });
    expect(chunks.every((c) => c.length <= 30)).toBe(true);
    expect(chunks.join("").length).toBe(100);
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
