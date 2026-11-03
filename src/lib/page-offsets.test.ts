import { describe, expect, it } from "vitest";
import { pageStartsUsable, relocatePageStarts } from "./page-offsets";

/** What `unwrapPdfPagesDetailed` reports before the normalize pass runs. */
const UNWRAPPED = "Chapter One\n\nThe lamps were lit.\n\nChapter Two\n\nNight settled.";

describe("relocatePageStarts", () => {
  it("keeps exact offsets when the text did not move", () => {
    const probes = ["Chapter One The lamps were lit.", "Chapter Two Night settled."];
    const expected = [0, UNWRAPPED.indexOf("Chapter Two")];
    const starts = relocatePageStarts(UNWRAPPED, probes, expected);
    expect(starts).toEqual(expected);
    expect(UNWRAPPED.slice(starts[1]!, starts[1]! + 11)).toBe("Chapter Two");
  });

  it("re-anchors a page whose whitespace was rewritten", () => {
    // The probe keeps single spaces; the normalized text has a paragraph break.
    const rewritten = "Chapter One\n\nThe lamps were lit.\n\nChapter Two\n\nNight settled.";
    const probes = ["Chapter One The lamps were lit. Chapter Two Night settled."];
    const starts = relocatePageStarts(rewritten, probes, [0]);
    expect(starts).toEqual([0]);
  });

  it("finds a page the rewrite shifted forward", () => {
    const shifted = "A dropped front matter line.\n\n" + UNWRAPPED;
    const probes = ["Chapter One The lamps were lit.", "Chapter Two Night settled."];
    const starts = relocatePageStarts(shifted, probes, [0, 30]);
    expect(shifted.slice(starts[0]!, starts[0]! + 11)).toBe("Chapter One");
    expect(shifted.slice(starts[1]!, starts[1]! + 11)).toBe("Chapter Two");
  });

  it("keeps the array ordered and one entry per page when an anchor is missing", () => {
    const probes = ["Chapter One The lamps were lit.", "a page that is not here", "Chapter Two Night settled."];
    const starts = relocatePageStarts(UNWRAPPED, probes, [0, 30, 30]);
    expect(starts).toHaveLength(3);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]!).toBeGreaterThanOrEqual(starts[i - 1]!);
    }
  });

  it("ignores an expected offset that points past the rewritten text", () => {
    const probes = ["Chapter One", "Chapter Two"];
    const starts = relocatePageStarts("Chapter One\n\nChapter Two", probes, [0, 99_999]);
    expect(starts.every((n) => n >= 0 && n <= "Chapter One\n\nChapter Two".length)).toBe(true);
    expect(starts[1]).toBeGreaterThanOrEqual(starts[0]!);
  });

  it("returns an empty array for no pages", () => {
    expect(relocatePageStarts("anything", [], [])).toEqual([]);
  });
});

describe("pageStartsUsable", () => {
  it("accepts non-decreasing in-range offsets", () => {
    expect(pageStartsUsable([0, 10, 10, 40], 50)).toBe(true);
  });

  it("rejects empty, negative, past-the-end, and unordered offsets", () => {
    expect(pageStartsUsable(undefined, 50)).toBe(false);
    expect(pageStartsUsable([], 50)).toBe(false);
    expect(pageStartsUsable([0, -1], 50)).toBe(false);
    expect(pageStartsUsable([0, 99], 50)).toBe(false);
    expect(pageStartsUsable([10, 5], 50)).toBe(false);
  });
});
