import { describe, expect, it } from "vitest";
import {
  allIndexesReady,
  canPlayIndex,
  claimIndexSet,
  lowestUnclaimedAfter,
  lowestUnreadyIndex,
  nextClaimableIndex,
  orderedReadyIndexes,
  runIndexBoundFanout,
  runRollingIndexPool,
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
  it("first claim takes the full fan-out starting at 0", () => {
    expect(
      claimIndexSet({ segments: [], total: 5, fanout: 3 })
    ).toEqual([0, 1, 2]);
    expect(
      claimIndexSet({ segments: [], total: 10, fanout: 4 })
    ).toEqual([0, 1, 2, 3]);
    expect(
      claimIndexSet({ segments: [], total: 10, fanout: 6 })
    ).toEqual([0, 1, 2, 3, 4, 5]);
    expect(
      claimIndexSet({ segments: [], total: 12, fanout: 12 })
    ).toHaveLength(8);
    expect(
      claimIndexSet({
        segments: [ready(0), ready(1), ready(2)],
        total: 5,
        fanout: 3,
      })
    ).toEqual([3, 4]);
  });

  it("does not reclaim permanently failed indexes until they are retryable holes", () => {
    const segments = [
      ready(0),
      { index: 1, path: "", status: "failed" as const },
      ready(2),
    ];
    expect(claimIndexSet({ segments, total: 4, fanout: 4 })).toEqual([3]);
    expect(
      claimIndexSet({
        segments: [
          ready(0),
          { index: 1, path: "", status: "retry" as const },
          ready(2),
          ready(3),
        ],
        total: 4,
        fanout: 4,
      })
    ).toEqual([1]);
  });

  it("fills holes before advancing past next_section_index", () => {
    const segments = [ready(0), ready(1), ready(2), ready(3), ready(5)];
    expect(claimIndexSet({ segments, total: 10, fanout: 4 })).toEqual([
      4, 6, 7, 8,
    ]);
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
    expect(orderedReadyIndexes(map, 5)).toEqual([0, 1, 2, 3, 4]);
  });

  it("refuses a concat transcript when an index is missing", () => {
    expect(() => orderedReadyIndexes([ready(0), ready(1), ready(3)], 4)).toThrow(
      /missing section/
    );
  });
});

describe("nextClaimableIndex", () => {
  it("skips indexes the tick has already claimed, then hands out retry holes", () => {
    const segments = [
      ready(0),
      { index: 1, path: "", status: "retry" as const },
      ready(2),
    ];
    // Index 1 not yet ready — but this tick already claimed it, so 3 comes next.
    expect(nextClaimableIndex(segments, 4, new Set([1]))).toBe(3);
    expect(nextClaimableIndex(segments, 4, new Set())).toBe(3);
    // Unattempted indexes claimed already → retry holes resurface.
    expect(nextClaimableIndex(segments, 4, new Set([1, 3]))).toBeNull();
  });

  it("never hands out ready or permanently failed indexes", () => {
    const segments = [
      ready(0),
      ready(1),
      { index: 2, path: "", status: "failed" as const },
    ];
    expect(nextClaimableIndex(segments, 3, new Set())).toBeNull();
  });
});

describe("runRollingIndexPool", () => {
  it("claims the next index as soon as a slot frees instead of one barrier", async () => {
    const finished: number[] = [];
    const slow: Array<() => void> = [];
    let started = 0;
    const pool = runRollingIndexPool({
      concurrency: 2,
      claimNext: async () => {
        if (started >= 4) return null;
        const index = started;
        started += 1;
        return index;
      },
      work: async (index) => {
        if (index === 0) {
          await new Promise<void>((resolve) => slow.push(resolve));
        }
        finished.push(index);
        return index;
      },
    });

    // Index 0 hangs, yet slots keep claiming and finishing 1..3 over it.
    for (let i = 0; i < 100 && finished.length < 3; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(finished).toEqual([1, 2, 3]);
    expect(started).toBe(4);

    for (const resolve of slow) resolve();
    const byIndex = await pool;
    expect(byIndex.get(0)).toBe(0);
    expect(finished).toEqual([1, 2, 3, 0]);
  });

  it("honors shouldStop before each claim and finishes the work in flight", async () => {
    const claims: number[] = [];
    const byIndex = await runRollingIndexPool({
      concurrency: 2,
      shouldStop: () => claims.length >= 1,
      claimNext: async () => {
        if (claims.length >= 4) return null;
        const index = claims.length;
        claims.push(index);
        return index;
      },
      work: async (index) => index,
    });
    expect(byIndex.size).toBe(1);
    expect(claims).toEqual([0]);
  });
});
