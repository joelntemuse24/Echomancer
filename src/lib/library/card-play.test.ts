import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  libraryCardCanOpen,
  libraryCardCanPlay,
  mediaSessionActive,
  partRowCanPlay,
  partRowLabel,
  playbackUrlForStatus,
  playerShowsPlay,
} from "./card-play";

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
    expect(partRowCanPlay("processing", true)).toBe(true);
    expect(mediaSessionActive("processing", true)).toBe(true);
    expect(playbackUrlForStatus("processing", "/api/storage/section.mp3")).toBe(
      "/api/storage/section.mp3"
    );
  });

  it("does not play a failed book that already has partial audio, including on first load", () => {
    const section = "/api/storage/audiobooks/job/sections/0000.mp3";
    expect(partRowCanPlay("failed", true)).toBe(false);
    expect(partRowLabel("failed", true)).toBe("Unavailable");
    expect(partRowLabel("processing", true)).toBe("Ready");
    expect(partRowLabel("processing", false)).toBe("Generating…");
    expect(mediaSessionActive("failed", true)).toBe(false);
    expect(playbackUrlForStatus("failed", section)).toBeNull();
    expect(playerShowsPlay("failed")).toBe(false);
    expect(libraryCardCanPlay({
      status: "failed",
      segments: [{ status: "ready" }, { status: "pending" }],
    })).toBe(false);
  });

  it("keeps the parts list and the media session on that same rule", () => {
    const source = readFileSync("src/app/dashboard/player/[id]/page.tsx", "utf8");
    expect(source).toContain("partRowCanPlay(job.status, isReady)");
    expect(source).toContain("mediaSessionActive(job?.status, Boolean(audioUrl))");
    expect(source).toContain("playbackUrlForStatus");
    expect(source).toContain("[jobStatus, audioUrl]");
  });
});
