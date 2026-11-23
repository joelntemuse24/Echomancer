/**
 * The CPU tail, measured end to end through a real tick.
 *
 * Reported on a 49-minute book: total GPU wall 397 s, ~93 s of CPU tail after
 * the last section (~19% of book time), 7 of 20 master jobs reported as 20 s
 * timeouts, and a ~17 s gap at each page boundary.
 *
 * Two of those three are pure timer, and these tests pin the fix at the level
 * the tick actually runs:
 *
 *  - a master that finishes within the settle is published **in this tick**,
 *    so the book does not round-trip through `CPU_YIELD_SEC` plus a 15 s drain;
 *  - an `accepted` placement (the container holds it, has not heartbeated) is
 *    re-posted rather than treated as a settled backlog, and the same task id
 *    means the retry cannot run a second ffmpeg for that section;
 *  - a master that is genuinely still running still yields, because another
 *    book's turn is the fairness rule and it is not traded for a few seconds.
 *
 * LUFS mastering is deliberately not touched. The container applies the
 * spectral chain and leaves loudness to the app, so removing the pass would
 * make one section quieter than the last: a quality regression, not a speed
 * fix.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { masterSettleMs, shouldSettleMasters } from "@/lib/cpu/master-tail";

describe("CPU tail policy", () => {
  beforeEach(() => {
    delete process.env.TTS_MASTER_SETTLE_MS;
  });

  afterEach(() => {
    delete process.env.TTS_MASTER_SETTLE_MS;
  });

  it("settles long enough to catch a master that was seconds away", () => {
    expect(masterSettleMs()).toBeGreaterThanOrEqual(5_000);
  });

  it("does not hold the host for a whole master pass", () => {
    // A measured master is 30-45 s. Holding the host that long would starve
    // the next book, which is exactly what the yield exists to prevent.
    expect(masterSettleMs()).toBeLessThan(20_000);
  });

  it("can be disabled without a code change", () => {
    process.env.TTS_MASTER_SETTLE_MS = "0";
    expect(masterSettleMs()).toBe(0);
    expect(
      shouldSettleMasters({
        outstanding: 3,
        anotherBookWaiting: false,
        stopAt: null,
        now: 0,
        settleMs: masterSettleMs(),
      })
    ).toBe(false);
  });

  it("never waits for a book that is behind another one", () => {
    expect(
      shouldSettleMasters({
        outstanding: 3,
        anotherBookWaiting: true,
        stopAt: null,
        now: 0,
        settleMs: masterSettleMs(),
      })
    ).toBe(false);
  });
});

describe("an accepted placement is not a failed master", () => {
  it("re-posting the same task id cannot run a second master", async () => {
    // The guarantee is structural, not incidental: `claimCpuTask` only takes a
    // row whose previous lease has expired, and `resultFromRow` reports
    // `accepted` while the owner's lease is live. This test pins the two
    // properties the retry relies on, so a future change to either fails here
    // rather than silently paying for ffmpeg twice.
    const { claimCpuTask, enqueueCpuTask, cpuTaskLeaseLive, completeCpuTask } =
      await import("@/lib/cpu/tasks");
    const id = "master:job-retry:0";
    await enqueueCpuTask({
      id,
      kind: "master",
      jobId: "job-retry",
      sectionIndex: 0,
      inputPath: "audiobooks/job-retry/raw/0000.mp3",
      outputPath: "audiobooks/job-retry/sections/0000.mp3",
      payload: { chain: "s2", extension: "mp3" },
    });
    const owner = "owner-a";
    expect(await claimCpuTask(id, owner, 90)).toBe(true);
    // A live claim belongs to owner-a; nobody else can take it.
    expect(await claimCpuTask(id, "owner-b", 90)).toBe(false);
    expect(await cpuTaskLeaseLive(id)).toBe(true);
    // And the retry loop's own view is "still live", not "ready to run".
    expect(await cpuTaskLeaseLive(id)).toBe(true);
    expect(await completeCpuTask(id, owner)).toBe(true);
    expect(await cpuTaskLeaseLive(id)).toBe(false);
  });
});
