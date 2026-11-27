import { describe, expect, it } from "vitest";
import { nextSectionPreloadUrl, preloadNextSection } from "@/lib/player/section-preload";
import type { JobSegment } from "@/lib/tts/types";

function ready(index: number): JobSegment {
  return {
    index,
    status: "ready",
    path: `audiobooks/job/sections/${String(index).padStart(4, "0")}.mp3`,
  };
}

describe("section preload", () => {
  it("preloads the following ready section and not one behind a hole", () => {
    const segments = [ready(0), ready(1), ready(3)];
    expect(
      nextSectionPreloadUrl({ segments, from: 0, status: "processing" })
    ).toBe("/api/storage/audiobooks/job/sections/0001.mp3");
    expect(
      nextSectionPreloadUrl({ segments, from: 1, status: "processing" })
    ).toBeNull();
  });

  it("loads the next file on a second element and leaves it unplayed", () => {
    const audio = { src: "", preload: "none", paused: true, playCount: 0 };
    const url = nextSectionPreloadUrl({
      segments: [ready(0), ready(1)],
      from: 0,
      status: "processing",
    });
    preloadNextSection(audio, url);
    expect(audio.preload).toBe("auto");
    expect(audio.src).toBe("/api/storage/audiobooks/job/sections/0001.mp3");
    expect(audio.playCount).toBe(0);
    preloadNextSection(audio, url);
    expect(audio.src).toBe("/api/storage/audiobooks/job/sections/0001.mp3");
    preloadNextSection(audio, null);
    expect(audio.src).toBe("");
    expect(audio.preload).toBe("none");
  });
});
