import { describe, expect, it } from "vitest";
import type { SectionSpan } from "@/lib/player/playback-position";
import {
  advanceAfterSection,
  continuePastPublishedPrefix,
  readySnapshotHandoff,
} from "@/lib/player/section-advance";
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

  it("continues past the published prefix when the rolling file ends", () => {
    const spans: SectionSpan[] = [
      { index: 0, startSeconds: 0, durationSeconds: 22 },
      { index: 1, startSeconds: 22, durationSeconds: 40 },
      { index: 2, startSeconds: 62, durationSeconds: 30 },
    ];
    const segments = spans.map((span) => ready(span.index));
    const mid = continuePastPublishedPrefix({
      src: "/api/storage/audiobooks/job/full.mp3?pb=2",
      endedAt: 61.5,
      spans,
      segments,
      status: "processing",
    });
    expect(mid).toMatchObject({
      action: "play",
      index: 1,
      path: "audiobooks/job/sections/0001.mp3",
    });
    if (mid.action === "play") expect(mid.localSeconds).toBeCloseTo(39.5, 1);

    const boundary = continuePastPublishedPrefix({
      src: "/api/storage/audiobooks/job/full.mp3?pb=2",
      endedAt: 62,
      spans,
      segments,
      status: "processing",
    });
    expect(boundary).toEqual({
      action: "play",
      index: 2,
      path: "audiobooks/job/sections/0002.mp3",
      localSeconds: 0,
    });
  });

  it("hands a rolling snapshot to the finished file at the same time", () => {
    const full = "/api/storage/audiobooks/job/full.mp3?v=2026-11-27T08%3A02%3A41.000Z&pb=2";
    expect(
      readySnapshotHandoff({
        status: "ready",
        src: "/api/storage/audiobooks/job/full.mp3?pb=2",
        fullUrl: full,
        currentTime: 158,
        playing: true,
      })
    ).toEqual({ action: "handoff", url: full, at: 158, play: true });
    expect(
      readySnapshotHandoff({
        status: "ready",
        src: `${full}&r=2`,
        fullUrl: full,
        currentTime: 158,
        playing: true,
      }).action
    ).toBe("stay");
    expect(
      readySnapshotHandoff({
        status: "ready",
        src: "/api/storage/audiobooks/job/sections/0003.mp3",
        fullUrl: full,
        currentTime: 10,
        playing: true,
      }).action
    ).toBe("stay");
    expect(
      readySnapshotHandoff({
        status: "processing",
        src: "/api/storage/audiobooks/job/full.mp3?pb=2",
        fullUrl: full,
        currentTime: 158,
        playing: true,
      }).action
    ).toBe("stay");
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
