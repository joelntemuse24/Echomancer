/**
 * The CPU tail: ~93 s (19% of book time) after the last GPU section landed,
 * 7 of 20 master jobs reported as 20 s timeouts, and a ~17 s gap per boundary.
 *
 * The three causes are pinned here, and so is the rule that none of them is
 * fixed by removing LUFS mastering — normalisation is not redundant with the
 * container's spectral chain, and dropping it would be a quality regression.
 */

import { describe, expect, it } from "vitest";
import {
  MASTER_ACCEPT_RETRIES_DEFAULT,
  MASTER_SETTLE_DEFAULT_MS,
  MASTER_SETTLE_MAX_MS,
  decideMasterOutcome,
  formatTailReport,
  isAcceptTimeout,
  logTailReport,
  masterAcceptRetries,
  masterQueueFromPage,
  masterSettleMs,
  shouldSettleMasters,
} from "@/lib/cpu/master-tail";

describe("masterSettleMs", () => {
  it("defaults to a short settle, not a master-length wait", () => {
    // A measured master is 30-45 s. The settle is only long enough to catch a
    // master that was seconds from landing, because the book must still yield
    // to another book rather than hold the host for a full pass.
    expect(masterSettleMs({})).toBe(MASTER_SETTLE_DEFAULT_MS);
    expect(MASTER_SETTLE_DEFAULT_MS).toBeLessThan(30_000);
    expect(MASTER_SETTLE_DEFAULT_MS).toBeGreaterThanOrEqual(5_000);
  });

  it("treats an unset variable as the default, not as zero", () => {
    // `Number("")` is 0. Reading an unset TTS_MASTER_SETTLE_MS as "never
    // settle" is exactly the class of bug that put a 17 s timer in the tail.
    expect(masterSettleMs({ TTS_MASTER_SETTLE_MS: "" })).toBe(MASTER_SETTLE_DEFAULT_MS);
    expect(masterSettleMs({ TTS_MASTER_SETTLE_MS: "   " })).toBe(MASTER_SETTLE_DEFAULT_MS);
  });

  it("accepts an explicit 0 to disable the settle", () => {
    expect(masterSettleMs({ TTS_MASTER_SETTLE_MS: "0" })).toBe(0);
  });

  it("is clamped so a bad value cannot hold the host", () => {
    expect(masterSettleMs({ TTS_MASTER_SETTLE_MS: "-5" })).toBe(MASTER_SETTLE_DEFAULT_MS);
    expect(masterSettleMs({ TTS_MASTER_SETTLE_MS: "9999999" })).toBe(MASTER_SETTLE_MAX_MS);
    expect(masterSettleMs({ TTS_MASTER_SETTLE_MS: "nonsense" })).toBe(MASTER_SETTLE_DEFAULT_MS);
  });

  it("stays well under the container budget so a master is never cut by it", () => {
    // CPU_FUNCTION_TIMEOUT_S defaults to 900 s.
    expect(MASTER_SETTLE_MAX_MS).toBeLessThan(900_000);
  });
});

describe("masterAcceptRetries", () => {
  it("defaults to retrying an accepted placement twice", () => {
    expect(masterAcceptRetries({})).toBe(MASTER_ACCEPT_RETRIES_DEFAULT);
    expect(masterAcceptRetries({ TTS_MASTER_ACCEPT_RETRIES: "0" })).toBe(0);
    expect(masterAcceptRetries({ TTS_MASTER_ACCEPT_RETRIES: "99" })).toBe(4);
  });
});

describe("isAcceptTimeout", () => {
  it("treats deferred as the container being busy, not the section failing", () => {
    expect(isAcceptTimeout("deferred")).toBe(true);
    expect(isAcceptTimeout("accepted")).toBe(false);
    expect(isAcceptTimeout("failed")).toBe(false);
    expect(isAcceptTimeout("done")).toBe(false);
  });
});

describe("decideMasterOutcome", () => {
  it("is ready only when the row is done AND the object exists", () => {
    expect(
      decideMasterOutcome({ result: "done", attemptsLeft: 0, outputExists: true })
    ).toEqual({ kind: "ready" });
    expect(
      decideMasterOutcome({ result: "done", attemptsLeft: 0, outputExists: false })
    ).toEqual({ kind: "failed", reason: "master published no object" });
  });

  it("keeps an accepted placement queued instead of failing the section", () => {
    // This is the 20 s case: the container holds the placement and has not
    // heartbeated yet. Failing here loses a section that is already running.
    expect(
      decideMasterOutcome({ result: "accepted", attemptsLeft: 0, outputExists: false })
    ).toEqual({ kind: "queued", reason: "accepted" });
    // A saturated host (nothing posted) is also queued, but for its own reason.
    expect(
      decideMasterOutcome({ result: "deferred", attemptsLeft: 0, outputExists: false })
    ).toEqual({ kind: "queued", reason: "deferred" });
  });

  it("reports an accepted placement as retryable while attempts remain", () => {
    expect(
      decideMasterOutcome({ result: "accepted", attemptsLeft: 2, outputExists: false })
    ).toEqual({ kind: "queued", reason: "accepted" });
    expect(
      decideMasterOutcome({ result: "deferred", attemptsLeft: 1, outputExists: false })
    ).toEqual({ kind: "queued", reason: "accepted" });
  });

  it("keeps an unavailable workspace queued so the caller can stop the book", () => {
    expect(
      decideMasterOutcome({ result: "unavailable", attemptsLeft: 0, outputExists: false })
    ).toEqual({ kind: "queued", reason: "unavailable" });
  });

  it("treats a lost lease as another worker's result, not a failure", () => {
    expect(
      decideMasterOutcome({ result: "lost", attemptsLeft: 0, outputExists: false })
    ).toEqual({ kind: "queued", reason: "accepted" });
  });

  it("fails only on the master's own message", () => {
    expect(
      decideMasterOutcome({
        result: "failed",
        attemptsLeft: 0,
        outputExists: false,
        error: "ffmpeg exited 1: invalid data",
      })
    ).toEqual({ kind: "failed", reason: "ffmpeg exited 1: invalid data" });
    expect(
      decideMasterOutcome({ result: "failed", attemptsLeft: 0, outputExists: false })
    ).toEqual({ kind: "failed", reason: "mastering did not finish" });
  });

  it("never reports a timeout as a failure reason", () => {
    for (const result of ["accepted", "deferred"] as const) {
      const outcome = decideMasterOutcome({ result, attemptsLeft: 0, outputExists: false });
      expect(outcome.kind).toBe("queued");
      expect(JSON.stringify(outcome)).not.toContain("timed out");
    }
  });
});

describe("masterQueueFromPage", () => {
  it("returns every staged, unpublished index in playback order", () => {
    const result = masterQueueFromPage({
      pageIndexes: [5, 3, 4],
      staged: new Set([3, 4, 5]),
      alreadyPublished: new Set(),
      lowestUnready: 3,
    });
    expect(result.indexes).toEqual([3, 4, 5]);
    expect(result.blockedBy).toBeNull();
  });

  it("skips a row the page planned but did not stage", () => {
    const result = masterQueueFromPage({
      pageIndexes: [0, 1, 2],
      staged: new Set([0, 2]),
      alreadyPublished: new Set(),
      lowestUnready: 0,
    });
    expect(result.indexes).toEqual([0, 2]);
  });

  it("skips a section whose master was already placed", () => {
    const result = masterQueueFromPage({
      pageIndexes: [0, 1],
      staged: new Set([0, 1]),
      alreadyPublished: new Set([0]),
      lowestUnready: 0,
    });
    expect(result.indexes).toEqual([1]);
  });

  it("reports a hole in front so the caller keeps playback order", () => {
    const result = masterQueueFromPage({
      pageIndexes: [4, 5],
      staged: new Set([4, 5]),
      alreadyPublished: new Set(),
      lowestUnready: 2,
    });
    expect(result.indexes).toEqual([4, 5]);
    expect(result.blockedBy).toBe(2);
  });

  it("does not deduplicate a section twice in one page", () => {
    const result = masterQueueFromPage({
      pageIndexes: [1, 1, 2],
      staged: new Set([1, 2]),
      alreadyPublished: new Set(),
      lowestUnready: 1,
    });
    expect(result.indexes).toEqual([1, 2]);
  });

  it("is empty when nothing on the page was staged", () => {
    const result = masterQueueFromPage({
      pageIndexes: [0, 1],
      staged: new Set(),
      alreadyPublished: new Set(),
      lowestUnready: 0,
    });
    expect(result.indexes).toEqual([]);
    expect(result.blockedBy).toBeNull();
  });
});

describe("shouldSettleMasters", () => {
  const BASE = {
    outstanding: 2,
    anotherBookWaiting: false,
    stopAt: null as number | null,
    now: 1_000,
    settleMs: MASTER_SETTLE_DEFAULT_MS,
  };

  it("settles while a master it placed is still running", () => {
    // Without this the tick released with CPU_YIELD_SEC and waited for the 15 s
    // drain even when the master was seconds from landing.
    expect(shouldSettleMasters(BASE)).toBe(true);
  });

  it("does not settle when nothing is outstanding", () => {
    expect(shouldSettleMasters({ ...BASE, outstanding: 0 })).toBe(false);
  });

  it("does not settle when the settle is disabled", () => {
    expect(shouldSettleMasters({ ...BASE, settleMs: 0 })).toBe(false);
  });

  it("yields to another book that is waiting", () => {
    // The fairness rule is unchanged: another book's turn is worth more than
    // this tick's last few seconds, and these masters are promoted next tick.
    expect(shouldSettleMasters({ ...BASE, anotherBookWaiting: true })).toBe(false);
  });

  it("stops at the tick's own deadline", () => {
    expect(shouldSettleMasters({ ...BASE, stopAt: 500, now: 600 })).toBe(false);
    expect(shouldSettleMasters({ ...BASE, stopAt: 2_000, now: 600 })).toBe(true);
  });
});

describe("formatTailReport", () => {
  const REPORT = {
    jobId: "job-abc",
    sections: 20,
    gpuWallMs: 304_000,
    tailMs: 93_000,
    placed: 20,
    promoted: 12,
    queued: 0,
    failed: 0,
    acceptRetries: 2,
  };

  it("puts both halves of the book's time on one line", () => {
    const line = formatTailReport(REPORT);
    expect(line).toContain("gpu_wall=304.0s");
    expect(line).toContain("tail=93.0s");
    // 93 / (304 + 93) is the ~19% the report quoted.
    expect(line).toContain("tail_share=23%");
  });

  it("reports the queue and the accepted retries", () => {
    const line = formatTailReport({ ...REPORT, queued: 3, acceptRetries: 4 });
    expect(line).toContain("queued=3");
    expect(line).toContain("accept_retries=4");
  });

  it("has no share when no GPU wall is known", () => {
    expect(formatTailReport({ ...REPORT, gpuWallMs: 0 })).toContain("tail_share=-");
  });

  it("cannot throw out to the tick", () => {
    expect(() =>
      logTailReport(REPORT, () => {
        throw new Error("logger exploded");
      })
    ).not.toThrow();
  });
});

describe("LUFS mastering is not part of the tail fix", () => {
  it("has no switch that skips the loudness pass", async () => {
    // The container applies EQ and leaves loudness to the app. If this module
    // ever grows a "skip master for speed" flag, this fails: removing the pass
    // would make one section quieter than the last.
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile("src/lib/cpu/master-tail.ts", "utf8")
    );
    expect(source).not.toMatch(/SKIP_MASTER|skipMaster|loudnorm\s*=\s*0/i);
    expect(source).toContain("not redundant");
  });
});
