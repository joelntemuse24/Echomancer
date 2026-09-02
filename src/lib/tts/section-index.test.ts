import { describe, expect, it } from "vitest";
import {
  allIndexesReady,
  canPlayIndex,
  claimIndexSet,
  concatTranscript,
  lowestUnclaimedAfter,
  lowestUnreadyIndex,
  nextPlayableIndex,
  runIndexBoundFanout,
  sectionObjectName,
  upsertSegment,
} from "@/lib/tts/section-index";
import type { JobSegment } from "@/lib/tts/types";

function ready(index: number): JobSegment {
  return {
    index,
    path: `audiobooks/job/sections/${String(index).padStart(4, "0")}.mp3`,
    status: "ready",
  };
}

describe("claimIndexSet", () => {
  it("claims section 0 (and 1) before the rest of the fan-out", () => {
    expect(
      claimIndexSet({ segments: [], total: 10, fanout: 4, prioritizeZero: true })
    ).toEqual([0, 1]);
    expect(
      claimIndexSet({
        segments: [ready(0)],
        total: 10,
        fanout: 4,
        prioritizeZero: true,
      })
    ).toEqual([1, 2, 3, 4]);
  });

  it("fills holes before advancing past next_section_index", () => {
    const segments = [ready(0), ready(1), ready(2), ready(3), ready(5)];
    expect(
      claimIndexSet({ segments, total: 10, fanout: 4, prioritizeZero: false })
    ).toEqual([4, 6, 7, 8]);
    expect(lowestUnreadyIndex(segments, 10)).toBe(4);
    expect(lowestUnclaimedAfter(segments, 10, [4, 6, 7, 8])).toBe(9);
  });
});

describe("playlist order", () => {
  it("will not play 0002 while 0001 is missing", () => {
    const segments = [ready(0), ready(2)];
    expect(canPlayIndex(segments, 0)).toBe(true);
    expect(canPlayIndex(segments, 1)).toBe(false);
    expect(canPlayIndex(segments, 2)).toBe(false);
    expect(nextPlayableIndex(segments, 0)).toBeNull();
  });
});

describe("index-bound fan-out", () => {
  it("five dummy synths with random sleeps concat as 0,1,2,3,4", async () => {
    const delays = [40, 25, 10, 35, 5];
    const finishOrder: number[] = [];
    const byIndex = await runIndexBoundFanout(
      [0, 1, 2, 3, 4],
      async (index) => {
        await new Promise((r) => setTimeout(r, delays[index]));
        finishOrder.push(index);
        return `audio-${index}`;
      },
      5
    );

    expect(finishOrder).toHaveLength(5);
    expect(new Set(finishOrder).size).toBe(5);
    expect(finishOrder[0]).toBe(4);

    const segments: JobSegment[] = [];
    for (const [index, bytes] of byIndex) {
      expect(bytes).toBe(`audio-${index}`);
      expect(sectionObjectName(index, "mp3")).toBe(
        `sections/${String(index).padStart(4, "0")}.mp3`
      );
      segments.push(
        upsertSegment(segments, ready(index))[segments.length] ?? ready(index)
      );
    }
    const map = [0, 1, 2, 3, 4].map((i) => ready(i));
    expect(allIndexesReady(map, 5)).toBe(true);
    expect(concatTranscript(map, 5)).toEqual([0, 1, 2, 3, 4]);
  });

  it("refuses a concat transcript when an index is missing", () => {
    expect(() => concatTranscript([ready(0), ready(1), ready(3)], 4)).toThrow(
      /missing section/
    );
  });
});
