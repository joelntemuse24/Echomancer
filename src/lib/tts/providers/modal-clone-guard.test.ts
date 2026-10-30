import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDatabase } from "@/test/harness";
import { execute } from "@/lib/turso";
import {
  cloneTakeIsTruncated,
  ensureModalCloneJobAllowed,
  modalCloneCallTimeoutMs,
  modalCloneCharCaps,
  modalCloneJobBlocked,
  modalCloneSpendAllowed,
  reserveModalCloneSpend,
  resetModalCloneGuardForTests,
  utcDayStartUnix,
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

describe("modal clone spend cap", () => {
  beforeEach(async () => {
    await resetDatabase();
    vi.stubEnv("MODAL_S2_USER_DAILY_CHARS", "1000");
    vi.stubEnv("MODAL_S2_GLOBAL_DAILY_CHARS", "2500");
  });

  it("counts this UTC day only", async () => {
    await execute(
      `INSERT INTO usage_logs (user_id, action, chars_processed, created_at)
       VALUES (?, 'modal_s2_clone', ?, ?)`,
      ["user_a", 900, utcDayStartUnix() - 10]
    );
    expect(await modalCloneSpendAllowed("user_a", 200)).toBe(true);
    expect(await reserveModalCloneSpend("user_a", 900)).toBe(true);
    expect(await modalCloneSpendAllowed("user_a", 100)).toBe(true);
    expect(await modalCloneSpendAllowed("user_a", 101)).toBe(false);
    expect(await modalCloneSpendAllowed("user_b", 200)).toBe(true);
  });

  it("stops every user once the global cap is full", async () => {
    expect(await reserveModalCloneSpend("user_a", 2500)).toBe(true);
    expect(await modalCloneSpendAllowed("user_b", 1)).toBe(false);
  });

  it("blocks the whole job when the remaining book does not fit", async () => {
    expect(await reserveModalCloneSpend("user_a", 800)).toBe(true);
    expect(
      await ensureModalCloneJobAllowed({ jobId: "job-1", userId: "user_a", chars: 300 })
    ).toBe(false);
    expect(modalCloneJobBlocked("job-1")).toBe(true);
    expect(modalCloneJobBlocked("job-2")).toBe(false);
  });

  it("allows a book that fits and a cap that is turned off", async () => {
    expect(
      await ensureModalCloneJobAllowed({ jobId: "job-2", userId: "user_a", chars: 400 })
    ).toBe(true);
    expect(modalCloneJobBlocked("job-2")).toBe(false);
    vi.stubEnv("MODAL_S2_USER_DAILY_CHARS", "off");
    vi.stubEnv("MODAL_S2_GLOBAL_DAILY_CHARS", "off");
    expect(modalCloneCharCaps().user).toBe(Number.POSITIVE_INFINITY);
    expect(await reserveModalCloneSpend("user_a", 5000)).toBe(true);
    expect(await modalCloneSpendAllowed("user_a", 5000)).toBe(true);
  });

  it("refuses Modal when the cap is zero", async () => {
    vi.stubEnv("MODAL_S2_USER_DAILY_CHARS", "0");
    expect(await modalCloneSpendAllowed("user_a", 1)).toBe(false);
  });
});
