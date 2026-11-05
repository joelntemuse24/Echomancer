import { describe, expect, it } from "vitest";
import {
  QWEN_CHUNK_MAX_CHARS,
  chunkQwenText,
  splitLongSentence,
  splitSentences,
} from "@/lib/tts/qwen-chunks";

const sentence = (n: number) =>
  `Sentence number ${n} carries a little history about the river towns and the people in them.`;

describe("splitSentences", () => {
  it("keeps abbreviations inside a sentence", () => {
    expect(splitSentences("Mr. Smith came home. He sat down.")).toEqual([
      "Mr. Smith came home.",
      "He sat down.",
    ]);
  });

  it("keeps closing quotes with their sentence", () => {
    expect(splitSentences('He said "Go." Then he left!')).toEqual(['He said "Go."', "Then he left!"]);
  });
});

describe("splitLongSentence", () => {
  it("cuts at a clause mark near the target and never past max", () => {
    const long = Array.from({ length: 12 }, (_, i) => `clause ${i} runs on a while`).join(", ") + ".";
    const parts = splitLongSentence(long, 120, 180);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(180);
    for (const p of parts.slice(0, -1)) expect(p.endsWith(",")).toBe(true);
    expect(parts.join(" ")).toBe(long);
  });

  it("falls back to a space when there is no clause mark", () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const parts = splitLongSentence(long, 100, 150);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(150);
    expect(parts.join(" ")).toBe(long);
  });
});

describe("chunkQwenText", () => {
  it("packs whole sentences toward the target and keeps every word", () => {
    const para = Array.from({ length: 12 }, (_, i) => sentence(i)).join(" ");
    const chunks = chunkQwenText(para, { targetChars: 220 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(QWEN_CHUNK_MAX_CHARS);
      expect(c.text).toMatch(/[.!?]$/);
    }
    expect(chunks.map((c) => c.text).join(" ")).toBe(para);
    expect(chunks[0]!.boundary).toBe("start");
    expect(chunks.slice(1).every((c) => c.boundary === "sentence")).toBe(true);
  });

  it("never crosses a paragraph and marks the paragraph boundary", () => {
    const text = `${sentence(1)}\n\n${sentence(2)}`;
    const chunks = chunkQwenText(text);
    expect(chunks.map((c) => c.boundary)).toEqual(["start", "paragraph"]);
  });

  it("lets a heading ride with the next paragraph and gives it an ending", () => {
    const chunks = chunkQwenText(`Chapter One\n\n${sentence(1)}`);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text.startsWith("Chapter One. Sentence")).toBe(true);
  });

  it("marks the pieces of an over-long sentence as clause boundaries", () => {
    const long = Array.from({ length: 20 }, (_, i) => `part ${i} of a winding thought`).join(", ") + ".";
    const chunks = chunkQwenText(long, { targetChars: 150, maxChars: 200 });
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.slice(1).every((c) => c.boundary === "clause")).toBe(true);
  });

  it("returns nothing for blank input", () => {
    expect(chunkQwenText(" \n\n ")).toEqual([]);
  });
});
