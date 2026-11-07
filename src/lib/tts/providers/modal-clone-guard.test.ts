import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDatabase } from "@/test/harness";
import { queryOne } from "@/lib/turso";
import {
  MODAL_CLONE_USAGE_ACTION,
  cloneTakeIsTruncated,
  modalCloneCallTimeoutMs,
  recordModalCloneUsage,
  resetModalCloneGuardForTests,
} from "./modal-clone-guard";

afterEach(() => {
  resetModalCloneGuardForTests();
  vi.unstubAllEnvs();
});

describe("modal clone call timeout", () => {
  it("stays inside 30–60 seconds", () => {
    vi.stubEnv("MODAL_S2_TIMEOUT_MS", "");
    expect(modalCloneCallTimeoutMs()).toBe(60_000);
    vi.stubEnv("MODAL_S2_TIMEOUT_MS", "45000");
    expect(modalCloneCallTimeoutMs()).toBe(45_000);
    vi.stubEnv("MODAL_S2_TIMEOUT_MS", "1000");
    expect(modalCloneCallTimeoutMs()).toBe(30_000);
    vi.stubEnv("MODAL_S2_TIMEOUT_MS", "180000");
    expect(modalCloneCallTimeoutMs()).toBe(60_000);
  });
});

describe("clone take length", () => {
  const long = "word ".repeat(200);

  it("accepts a fast read that is still at least half the 900-char pace", () => {
    // 1000 characters at 900/min is 66.7s. 200 wpm is about three quarters of that.
    expect(
      cloneTakeIsTruncated({ text: long, durationSeconds: 50, truncatedUnits: 0 }).truncated
    ).toBe(false);
  });

  it("rejects audio under half the expected duration", () => {
    const verdict = cloneTakeIsTruncated({ text: long, durationSeconds: 12, truncatedUnits: 0 });
    expect(verdict.truncated).toBe(true);
    expect(verdict.reason).toMatch(/900 chars/);
  });

  it("rejects a server truncated_units count even when the audio is long", () => {
    expect(
      cloneTakeIsTruncated({ text: long, durationSeconds: 80, truncatedUnits: 1 }).truncated
    ).toBe(true);
  });

  it("leaves a short heading alone when the server did not truncate it", () => {
    expect(
      cloneTakeIsTruncated({ text: "Chapter One.", durationSeconds: 1, truncatedUnits: 0 })
        .truncated
    ).toBe(false);
  });
});

describe("there is no generation allowance", () => {
  /**
   * Joel, 2026-11-07: *"Get rid of the allowance in general"*.
   *
   * Before this, a per-account cap (500,000 chars/day) and a global cap
   * (2,000,000) refused the GPU pool once exceeded. `job 75944dc9` was refused
   * at 492,425 + 17,022 against 500,000 and the refusal was reported as
   * "Clone provider modal failed" with zero requests in Modal's log.
   *
   * What must be true now:
   *   - no env var and no default can make generation refuse;
   *   - usage is still recorded, so cost stays observable;
   *   - recording is best-effort and cannot block.
   */
  beforeEach(async () => {
    await resetDatabase();
  });

  it("exposes no cap reader at all", async () => {
    const guard = await import("./modal-clone-guard");
    for (const name of [
      "modalCloneCharCaps",
      "modalCloneSpendAllowed",
      "reserveModalCloneSpend",
      "ensureModalCloneJobAllowed",
      "checkModalCloneJobBudget",
      "modalCloneJobBlocked",
      "blockModalCloneJob",
      "utcDayStartUnix",
      "DEFAULT_MODAL_USER_DAILY_CHARS",
      "DEFAULT_MODAL_GLOBAL_DAILY_CHARS",
    ]) {
      expect(guard).not.toHaveProperty(name);
    }
  });

  it("ignores leftover cap env vars entirely", async () => {
    // A worker whose .env still carries the old names must not be limited by
    // them. Nothing reads these, so a stale file cannot silently reintroduce
    // the refusal.
    vi.stubEnv("MODAL_S2_USER_DAILY_CHARS", "1");
    vi.stubEnv("MODAL_S2_GLOBAL_DAILY_CHARS", "1");
    await expect(recordModalCloneUsage("user_a", 500_000)).resolves.toBeUndefined();
  });

  it("records usage so cost stays observable", async () => {
    await recordModalCloneUsage("user_a", 17_022);
    await recordModalCloneUsage("user_a", 900);
    const row = await queryOne<{ total: number | bigint | null; rows: number | bigint | null }>(
      `SELECT COALESCE(SUM(chars_processed), 0) AS total, COUNT(*) AS rows
       FROM usage_logs WHERE user_id = ? AND action = ?`,
      ["user_a", MODAL_CLONE_USAGE_ACTION]
    );
    expect(Number(row?.total)).toBe(17_922);
    expect(Number(row?.rows)).toBe(2);
  });

  it("never blocks generation when the ledger cannot be written", async () => {
    // The old ledger read was an enforcement point: an unreadable usage table
    // blocked every clone section. Recording must be the opposite — it is
    // accounting, and losing one row cannot stop a book. The write goes through
    // the shared `logUsage`, which already swallows and logs failures.
    const turso = await import("@/lib/turso");
    const spy = vi.spyOn(turso, "execute").mockRejectedValueOnce(
      new Error("turso unavailable")
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(recordModalCloneUsage("user_a", 12_000)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to log"),
      expect.anything()
    );
    spy.mockRestore();
  });

  it("records nothing for a non-positive count and still resolves", async () => {
    await expect(recordModalCloneUsage("user_a", 0)).resolves.toBeUndefined();
    await expect(recordModalCloneUsage("user_a", -5)).resolves.toBeUndefined();
    const row = await queryOne<{ rows: number | bigint | null }>(
      `SELECT COUNT(*) AS rows FROM usage_logs WHERE action = ?`,
      [MODAL_CLONE_USAGE_ACTION]
    );
    expect(Number(row?.rows)).toBe(0);
  });
});
