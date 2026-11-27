import { describe, expect, it } from "vitest";
import { advanceAfterSection } from "@/lib/player/section-advance";
import type { JobSegment } from "@/lib/tts/types";

function ready(index: number): JobSegment {
  return {
    index,
    status: "ready",
    path: `audiobooks/job/sections/${String(index).padStart(4, "0")}.mp3`,
  };
}

/**
 * Headless stand-in for the player element's `ended` event. The real page
 * asks {@link advanceAfterSection} and either points src at the next file
 * or waits for the poll that fills the hole.
 */
function onSectionEnded(
  segments: JobSegment[],
  from: number,
  status: string
): { src: string | null; waiting: boolean } {
  const advance = advanceAfterSection({ segments, from, status });
  if (advance.action === "play") {
    return { src: `/api/storage/${advance.path}`, waiting: false };
  }
  return { src: null, waiting: advance.action === "wait" };
}

describe("section auto-advance", () => {
  it("plays the next ready section and waits at a hole", () => {
    const gapped = [ready(0), ready(1), ready(3), ready(4)];
    expect(onSectionEnded(gapped, 0, "processing")).toEqual({
      src: "/api/storage/audiobooks/job/sections/0001.mp3",
      waiting: false,
    });
    const held = onSectionEnded(gapped, 1, "processing");
    expect(held.waiting).toBe(true);
    expect(held.src).toBeNull();

    const filled = [ready(0), ready(1), ready(2), ready(3), ready(4)];
    expect(onSectionEnded(filled, 1, "processing")).toEqual({
      src: "/api/storage/audiobooks/job/sections/0002.mp3",
      waiting: false,
    });
  });

  it("steps over a hole once the book is finished", () => {
    const gapped = [ready(0), ready(1), ready(3)];
    expect(onSectionEnded(gapped, 1, "ready")).toEqual({
      src: "/api/storage/audiobooks/job/sections/0003.mp3",
      waiting: false,
    });
    expect(onSectionEnded(gapped, 3, "ready")).toEqual({ src: null, waiting: false });
  });
});
