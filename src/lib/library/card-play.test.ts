import { describe, expect, it } from "vitest";
import { libraryCardCanOpen, libraryCardCanPlay, playerShowsPlay } from "./card-play";

describe("libraryCardCanPlay", () => {
  it("does not offer play for a failed book that still has a section or a stream", () => {
    expect(
      libraryCardCanPlay({
        status: "failed",
        segments: [{ status: "ready" }],
      })
    ).toBe(false);
    expect(
      libraryCardCanPlay({
        status: "failed",
        job_kind: "stream",
      })
    ).toBe(false);
    expect(libraryCardCanOpen({ status: "failed", job_kind: "stream" })).toBe(false);
    expect(playerShowsPlay("failed")).toBe(false);
  });

  it("still offers play for a ready book and for a generating book with a section", () => {
    expect(libraryCardCanPlay({ status: "ready" })).toBe(true);
    expect(
      libraryCardCanPlay({
        status: "processing",
        segments: [{ status: "ready" }],
      })
    ).toBe(true);
    expect(libraryCardCanOpen({ status: "queued" })).toBe(true);
    expect(playerShowsPlay("ready")).toBe(true);
    expect(playerShowsPlay("processing")).toBe(true);
  });
});
