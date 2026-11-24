import { describe, expect, it } from "vitest";
import { execute, query, queryOne } from "@/lib/turso";
import { resetDatabase } from "@/test/harness";
import { storagePrefixBounds } from "@/lib/storage-prefix";
import { takehomeCandidateListSql } from "@/lib/jobs/takehome-fairness";
import { kokoroFleetCountArgs, kokoroFleetCountSql } from "@/lib/tts/kokoro-fleet-sql";
import { OTHER_RUNNABLE_TAKEHOME_SQL } from "@/lib/tts/process-job";
import { OPEN_REMOTE_CALLS_SQL } from "@/lib/remote/store";
import {
  ensureTtsJobColumns,
  resetSchemaMigrationCache,
} from "@/lib/tts/schema-migrate";
import { createRateLimiter, resetRateLimitTableCache } from "@/lib/rate-limit";
import { isTursoQuotaError, isWorkerLoopFatal } from "@/lib/transient-error";

async function plan(
  sql: string,
  args: (string | number | boolean | null)[] = []
): Promise<string> {
  const rows = await query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, args);
  return rows.map((row) => String(row.detail ?? "")).join("\n");
}

function expectNoScan(planText: string, table: string): void {
  expect(planText, planText).not.toMatch(new RegExp(`\\bSCAN ${table}\\b`));
  expect(planText, planText).toMatch(/SEARCH|USING INDEX/);
}

describe("storage prefix bounds", () => {
  it("keeps a sibling id outside the folder", () => {
    const bounds = storagePrefixBounds("pdfs/abc/");
    expect(bounds).toEqual({ start: "pdfs/abc/", end: "pdfs/abc0" });
    const inside = (path: string) => path >= bounds.start && path < bounds.end;
    expect(inside("pdfs/abc/content.txt")).toBe(true);
    expect(inside("pdfs/abc-extra/content.txt")).toBe(false);
    expect(inside("pdfs/abcd/content.txt")).toBe(false);
  });
});

describe("Turso quota errors", () => {
  it("recognises BLOCKED on the error or its cause and does not treat it as fatal", () => {
    const blocked = Object.assign(
      new Error("BLOCKED: SQL read operations are forbidden"),
      { code: "BLOCKED" }
    );
    expect(isTursoQuotaError(blocked)).toBe(true);
    expect(isTursoQuotaError(new Error("SQL read operations are forbidden"))).toBe(true);
    const wrapped = new Error("libsql");
    (wrapped as Error & { cause?: unknown }).cause = blocked;
    expect(isTursoQuotaError(wrapped)).toBe(true);
    expect(isWorkerLoopFatal(blocked)).toBe(false);
    expect(isWorkerLoopFatal(new TypeError("releaseExpired is not a function"))).toBe(true);
  });
});

describe("hot query plans", () => {
  it("searches indexes instead of scanning jobs, remote calls, and rate limits", async () => {
    await resetDatabase();
    for (let i = 0; i < 40; i += 1) {
      await execute(
        `INSERT INTO jobs (
           id, user_id, book_title, pdf_storage_path, status, job_kind, tts_provider
         ) VALUES (?, 'user-a', 'Book', ?, 'ready', 'takehome', 'edge')`,
        [`ready-${i}`, `pdfs/other-${i}/content.txt`]
      );
    }
    await execute(
      `INSERT INTO jobs (
         id, user_id, book_title, pdf_storage_path, status, job_kind, tts_provider, updated_at
       ) VALUES ('queued-1', 'user-a', 'Book', 'pdfs/upload-1/content.txt', 'queued', 'takehome', 'drew', 10)`
    );
    await execute(`ANALYZE`);

    const drain = takehomeCandidateListSql({ expiredProcessing: true });
    expectNoScan(await plan(drain.sql, [...drain.args, 50]), "jobs");
    expect(await plan(drain.sql, [...drain.args, 50])).toMatch(/idx_jobs_takehome_active/);

    const queued = takehomeCandidateListSql({ expiredProcessing: false });
    expectNoScan(await plan(queued.sql, [...queued.args, 3]), "jobs");

    expectNoScan(
      await plan(kokoroFleetCountSql(), kokoroFleetCountArgs("queued-1")),
      "jobs"
    );
    expect(await plan(kokoroFleetCountSql(), kokoroFleetCountArgs("queued-1"))).toMatch(
      /idx_jobs_kokoro_active/
    );

    expectNoScan(await plan(OTHER_RUNNABLE_TAKEHOME_SQL, ["queued-1", "queued-1", "queued-1"]), "jobs");

    const bounds = storagePrefixBounds("pdfs/upload-1/");
    expectNoScan(
      await plan(
        `SELECT COUNT(*) AS total FROM jobs
         WHERE pdf_storage_path >= ? AND pdf_storage_path < ?`,
        [bounds.start, bounds.end]
      ),
      "jobs"
    );

    await execute(
      `INSERT INTO users (id, google_sub, email, email_verified, created_at)
       VALUES ('user_1', 'sub-1', 'Person@Example.com', 1, 1)`
    );
    const emailPlan = await plan(
      `SELECT * FROM users
       WHERE lower(email) = ? AND email_verified = 1
       ORDER BY created_at ASC
       LIMIT 1`,
      ["person@example.com"]
    );
    expectNoScan(emailPlan, "users");
    expect(emailPlan).toMatch(/idx_users_email_lower/);

    const now = Date.now();
    for (let i = 0; i < 80; i += 1) {
      await execute(
        `INSERT INTO remote_calls (
           id, flight_key, idempotency_key, provider, path, status, outcome, started_at, ended_at
         ) VALUES (?, ?, ?, 's2-clone', 'book', ?, ?, ?, ?)`,
        [
          `rc-${i}`,
          `flight-${i % 10}`,
          `flight-${i % 10}`,
          i % 3 === 0 ? "success" : "started",
          i % 3 === 0 ? "success" : "started",
          now - i * 1000,
          i % 3 === 0 ? now : null,
        ]
      );
    }
    await execute(`ANALYZE`);
    expectNoScan(await plan(OPEN_REMOTE_CALLS_SQL, [now - 60_000]), "remote_calls");
    expect(await plan(OPEN_REMOTE_CALLS_SQL, [now - 60_000])).toMatch(/idx_remote_calls_started/);
    expectNoScan(
      await plan(
        `SELECT s.flight_key
         FROM remote_calls s
         WHERE s.outcome = 'started' AND s.started_at >= ?`,
        [Date.now() - 86_400_000]
      ),
      "remote_calls"
    );
    expectNoScan(
      await plan(
        `UPDATE remote_calls
         SET call_id = COALESCE(?, call_id)
         WHERE rowid = (SELECT MAX(rowid) FROM remote_calls WHERE flight_key = ?)`,
        ["call", "flight"]
      ),
      "remote_calls"
    );

    resetRateLimitTableCache();
    const limit = createRateLimiter("plan", 5, 60_000);
    expect(await limit("reader")).toBe(true);
    expectNoScan(
      await plan(`DELETE FROM rate_limits WHERE window_start < ?`, [0]),
      "rate_limits"
    );

    await execute(
      `INSERT INTO playback_positions (user_id, job_id, position_seconds, updated_at)
       VALUES ('user-a', 'queued-1', 1.5, 1)`
    );
    expectNoScan(
      await plan(
        `SELECT job_id FROM playback_positions WHERE user_id = ? AND job_id = ?
         UNION ALL
         SELECT job_id FROM playback_positions WHERE user_id = ? AND job_id = ?`,
        ["user-a", "queued-1", "user-a", "ready-0"]
      ),
      "playback_positions"
    );

    expectNoScan(
      await plan(
        `SELECT COUNT(*) AS n FROM youtube_clips WHERE created_at >= ?`,
        [1]
      ),
      "youtube_clips"
    );
  });

  it("creates a missing index on the hot path without rebuilding tables", async () => {
    await resetDatabase();
    await execute(`DROP INDEX idx_jobs_kokoro_active`);
    const before = await queryOne<{ name: string | null }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_jobs_kokoro_active'`
    );
    expect(before?.name ?? null).toBeNull();
    resetSchemaMigrationCache();
    expect(await ensureTtsJobColumns()).toBe("hot");
    const after = await queryOne<{ name: string | null }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_jobs_kokoro_active'`
    );
    expect(after?.name).toBe("idx_jobs_kokoro_active");
    const jobs = await queryOne<{ sql: string | null }>(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'`
    );
    expect(jobs?.sql ?? "").toMatch(/CREATE TABLE/);
  });
});
