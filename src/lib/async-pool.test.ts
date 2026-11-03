import { describe, expect, it } from "vitest";
import { mapPool } from "./async-pool";

describe("mapPool", () => {
  it("keeps result order regardless of completion order", async () => {
    const delays = [30, 5, 20, 1];
    const out = await mapPool(delays, 4, async (ms, i) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:30", "1:5", "2:20", "3:1"]);
  });

  it("never runs more than the limit at once", async () => {
    let live = 0;
    let peak = 0;
    await mapPool([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 5));
      live -= 1;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("returns an empty array without invoking the callback", async () => {
    let calls = 0;
    const out = await mapPool([], 4, async () => {
      calls += 1;
      return 1;
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it("treats a non-positive limit as one worker", async () => {
    const out = await mapPool([1, 2, 3], 0, async (n) => n * 2);
    expect(out).toEqual([2, 4, 6]);
  });

  it("propagates a rejection", async () => {
    await expect(
      mapPool([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      })
    ).rejects.toThrow("boom");
  });
});
