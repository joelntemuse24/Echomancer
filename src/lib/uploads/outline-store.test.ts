import { describe, expect, it } from "vitest";
import { OUTLINE_VERSION, parseOutline } from "./outline-store";
import type { ChapterHint } from "@/lib/book-chapters";

const HINT: ChapterHint = {
  source: "pdf-outline",
  titles: [
    { title: "Chapter One", level: 1, pageIndex: 2, anchors: ["Chapter One"] },
    { title: "Part Two", level: 1, pageIndex: 3 },
  ],
  pageStarts: [0, 11, 13, 177],
  tocLines: ["Chapter One ..... 3"],
  pageProbes: ["Chapter One The lamps", "Part Two Night"],
};

function roundTrip(hint: ChapterHint): ChapterHint | null {
  return parseOutline(JSON.stringify({ version: OUTLINE_VERSION, hint }));
}

describe("parseOutline", () => {
  it("round-trips a full hint", () => {
    expect(roundTrip(HINT)).toEqual(HINT);
  });

  it("keeps page offsets and probes, the fields the old code threw away", () => {
    expect(roundTrip(HINT)?.pageStarts).toEqual([0, 11, 13, 177]);
    expect(roundTrip(HINT)?.pageProbes).toHaveLength(2);
  });

  it("rejects a different schema version", () => {
    expect(parseOutline(JSON.stringify({ version: 99, hint: HINT }))).toBeNull();
  });

  it("rejects malformed JSON and non-objects", () => {
    expect(parseOutline("{")).toBeNull();
    expect(parseOutline("null")).toBeNull();
    expect(parseOutline('"a string"')).toBeNull();
  });

  it("rejects an unknown source", () => {
    expect(
      parseOutline(JSON.stringify({ version: 1, hint: { source: "made-up", titles: [] } }))
    ).toBeNull();
  });

  it("drops titles that are not shaped like a heading", () => {
    const parsed = parseOutline(
      JSON.stringify({
        version: 1,
        hint: { source: "pdf-outline", titles: [{ title: "ok", level: 1 }, { level: 2 }, { title: 5 }] },
      })
    );
    expect(parsed?.titles).toEqual([{ title: "ok", level: 1 }]);
  });

  it("drops a non-numeric page map rather than trusting it", () => {
    const parsed = parseOutline(
      JSON.stringify({
        version: 1,
        hint: { source: "pdf-outline", titles: [], pageStarts: [0, "x", 5] },
      })
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.pageStarts).toBeUndefined();
  });

  it("accepts a minimal hint", () => {
    expect(roundTrip({ source: "heading-lines", titles: [] })).toEqual({
      source: "heading-lines",
      titles: [],
    });
  });
});
