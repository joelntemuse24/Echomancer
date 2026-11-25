import { afterEach, describe, expect, it, vi } from "vitest";
import { execute, executeBatch, query, queryOne } from "@/lib/turso";
import { resetDatabase } from "@/test/harness";
import { storagePrefixBounds } from "@/lib/storage-prefix";
import { bookSpend, dailySpend, REMOTE_DAY_MS, remoteCallCapMs, resetRemoteLayerForTests } from "@/lib/remote/layer";
import {
  loadPersistedSpend,
  PERSISTED_SPEND_SQL,
  REMOTE_REPAIR_INTERVAL_MS,
  REPAIR_INFLATED_REMOTE_CALLS_SQL,
  remoteRepairSqlRunCount,
  repairInflatedRemoteCalls,
} from "@/lib/remote/store";
import {
  ensureTtsJobColumns,
  resetSchemaMigrationCache,
  schemaEnsureDbPasses,
} from "@/lib/tts/schema-migrate";
import { createRateLimiter, resetRateLimitTableCache } from "@/lib/rate-limit";
import { isTursoQuotaError, isWorkerLoopFatal } from "@/lib/transient-error";

const REMOTE_INDEXES = [
  "idx_remote_calls_started",
  "idx_remote_calls_outcome_started",
  "idx_remote_calls_ended",
  "idx_remote_calls_flight_end",
  "idx_remote_calls_flight_outcome_end",
  "idx_remote_calls_open",
];

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

describe("schema ensure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("talks to the database once per process", async () => {
    await resetDatabase();
    resetSchemaMigrationCache();
    expect(await ensureTtsJobColumns()).toBe("hot");
    const passes = schemaEnsureDbPasses();
    expect(await ensureTtsJobColumns()).toBe("hot");
    expect(schemaEnsureDbPasses()).toBe(passes);
  });

  it("does not retry schema SQL while Turso reads are blocked", async () => {
    await resetDatabase();
    resetSchemaMigrationCache();
    const blocked = Object.assign(
      new Error("BLOCKED: SQL read operations are forbidden"),
      { code: "BLOCKED" }
    );
    const batch = vi.spyOn(await import("@/lib/turso"), "executeBatch").mockRejectedValue(blocked);
    await ensureTtsJobColumns();
    const calls = batch.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    await ensureTtsJobColumns();
    expect(batch.mock.calls.length).toBe(calls);
    batch.mockRestore();
    resetSchemaMigrationCache();
    expect(await ensureTtsJobColumns()).toBe("hot");
  });

  it("retries a CREATE INDEX that failed for a reason other than quota", async () => {
    await resetDatabase();
    resetSchemaMigrationCache();
    const turso = await import("@/lib/turso");
    const batch = vi.spyOn(turso, "executeBatch").mockRejectedValue(new Error("index failed"));
    const exec = vi.spyOn(turso, "execute").mockRejectedValue(new Error("index failed"));
    expect(await ensureTtsJobColumns()).toBe("migrated");
    const passes = schemaEnsureDbPasses();
    expect(await ensureTtsJobColumns()).toBe("migrated");
    expect(schemaEnsureDbPasses()).toBe(passes + 1);
    batch.mockRestore();
    exec.mockRestore();
    resetSchemaMigrationCache();
    expect(await ensureTtsJobColumns()).toBe("hot");
  });

  it("creates a missing remote_calls index on the hot path without rebuilding tables", async () => {
    await resetDatabase();
    await execute(`DROP INDEX idx_remote_calls_flight_end`);
    const before = await queryOne<{ name: string | null }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_remote_calls_flight_end'`
    );
    expect(before?.name ?? null).toBeNull();
    resetSchemaMigrationCache();
    expect(await ensureTtsJobColumns()).toBe("hot");
    const after = await queryOne<{ name: string | null }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_remote_calls_flight_end'`
    );
    expect(after?.name).toBe("idx_remote_calls_flight_end");
    const jobs = await queryOne<{ sql: string | null }>(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'`
    );
    expect(jobs?.sql ?? "").toMatch(/CREATE TABLE/);
  });
});

describe("remote_calls rows read", () => {
  it("looks up flight ends by index and estimates far fewer rows on 5k calls", async () => {
    await resetDatabase();
    const now = Date.now();
    const tableRows = 5000;
    const flights = 800;
    const statements: { sql: string; args: (string | number | null)[] }[] = [];
    for (let i = 0; i < tableRows; i += 1) {
      const outcome = i % 7 === 0 ? "started" : i % 5 === 0 ? "abandoned" : "success";
      const started = now - (i % 4000) * 60_000;
      const ended = outcome === "started" && i % 11 !== 0 ? null : started + (i % 9) * 3_600_000;
      statements.push({
        sql: `INSERT INTO remote_calls (
           id, flight_key, idempotency_key, provider, path, job_id, status, outcome, started_at, ended_at
         ) VALUES (?, ?, ?, 's2-clone', 'book', ?, ?, ?, ?, ?)`,
        args: [
          `rc-${i}`,
          `flight-${i % flights}`,
          `flight-${i % flights}`,
          `job-${i % flights}`,
          outcome,
          outcome,
          started,
          ended,
        ],
      });
    }
    await executeBatch(statements);

    const legacySpend = `SELECT s.flight_key,
            (SELECT MIN(e.ended_at) FROM remote_calls e
              WHERE e.flight_key = s.flight_key
                AND e.ended_at IS NOT NULL
                AND e.ended_at > s.started_at
                AND e.outcome IN ('success', 'failure', 'cancelled', 'timeout', 'abandoned')
            ) AS terminal_end,
            (SELECT MIN(e.ended_at) FROM remote_calls e
              WHERE e.flight_key = s.flight_key
                AND e.ended_at IS NOT NULL
                AND e.ended_at > s.started_at
            ) AS any_end
     FROM remote_calls s
     WHERE s.outcome = 'started'`;
    const legacyRepair = `UPDATE remote_calls
       SET ended_at = started_at + ?
       WHERE ended_at IS NOT NULL
         AND started_at > 0
         AND ended_at > started_at + ?`;

    for (const name of REMOTE_INDEXES) {
      await execute(`DROP INDEX IF EXISTS ${name}`);
    }
    await execute(`PRAGMA automatic_index = OFF`);
    const beforeSpend = await plan(legacySpend);
    const beforeRepair = await plan(legacyRepair, [1, 1]);
    // No flight index: the inner lookup is not `SEARCH e USING INDEX`.
    // This SQLite build labels that full examination `SEARCH e`.
    expect(beforeSpend, beforeSpend).not.toMatch(/USING INDEX/);
    expect(beforeRepair, beforeRepair).toMatch(/SCAN remote_calls/);

    const started = Number(
      (
        await queryOne<{ n: number }>(
          `SELECT COUNT(*) AS n FROM remote_calls WHERE outcome = 'started'`
        )
      )?.n ?? 0
    );
    const rowsReadBefore = started * 2 * tableRows + tableRows;
    expect(started).toBeGreaterThan(600);
    expect(rowsReadBefore).toBeGreaterThan(6_000_000);

    resetSchemaMigrationCache();
    expect(await ensureTtsJobColumns()).toBe("hot");
    await execute(`ANALYZE`);

    const afterSpend = await plan(PERSISTED_SPEND_SQL);
    expect(afterSpend, afterSpend).toMatch(
      /SEARCH e USING (COVERING )?INDEX idx_remote_calls_flight_outcome_end/
    );
    expect(afterSpend, afterSpend).toMatch(
      /SEARCH e USING (COVERING )?INDEX idx_remote_calls_flight_end/
    );
    expect(afterSpend, afterSpend).toMatch(/idx_remote_calls_outcome_started/);
    expect(afterSpend, afterSpend).not.toMatch(/\bSCAN remote_calls\b/);
    expect(afterSpend, afterSpend).not.toMatch(/\bSCAN e\b/);
    expect(afterSpend, afterSpend).not.toMatch(/started_at>/);

    const dayStart = now - REMOTE_DAY_MS;
    const afterRepair = await plan(REPAIR_INFLATED_REMOTE_CALLS_SQL, [1, dayStart, 1]);
    expect(afterRepair, afterRepair).toMatch(/SEARCH remote_calls USING INDEX idx_remote_calls_ended/);
    expect(afterRepair, afterRepair).not.toMatch(/\bSCAN remote_calls\b/);

    const terminalHits = Number(
      (
        await queryOne<{ n: number }>(
          `SELECT COUNT(*) AS n
           FROM remote_calls s
           JOIN remote_calls e ON e.flight_key = s.flight_key
            AND e.ended_at IS NOT NULL
            AND e.ended_at > s.started_at
            AND e.outcome IN ('success', 'failure', 'cancelled', 'timeout', 'abandoned')
           WHERE s.outcome = 'started'`
        )
      )?.n ?? 0
    );
    const anyHits = Number(
      (
        await queryOne<{ n: number }>(
          `SELECT COUNT(*) AS n
           FROM remote_calls s
           JOIN remote_calls e ON e.flight_key = s.flight_key
            AND e.ended_at IS NOT NULL
            AND e.ended_at > s.started_at
           WHERE s.outcome = 'started'`
        )
      )?.n ?? 0
    );
    const rowsReadAfter = started + terminalHits + anyHits;
    expect(rowsReadAfter).toBeLessThan(rowsReadBefore / 50);

    const loaded = await query<{
      flight_key: string;
      started_at: number;
      terminal_end: number | null;
    }>(PERSISTED_SPEND_SQL);
    expect(loaded.length).toBe(started);
    const sample = loaded.find((row) => Number(row.started_at) < dayStart);
    expect(sample, "a started row older than a day must still load").toBeTruthy();
    const expected = await queryOne<{ terminal_end: number | null }>(
      `SELECT MIN(e.ended_at) AS terminal_end
       FROM remote_calls s
       JOIN remote_calls e ON e.flight_key = s.flight_key
        AND e.ended_at IS NOT NULL
        AND e.ended_at > s.started_at
        AND e.outcome IN ('success', 'failure', 'cancelled', 'timeout', 'abandoned')
       WHERE s.flight_key = ?
         AND s.outcome = 'started'
         AND s.started_at < ?`,
      [sample!.flight_key, dayStart]
    );
    const sampleEnd = sample!.terminal_end == null ? null : Number(sample!.terminal_end);
    const expectedEnd = expected?.terminal_end == null ? null : Number(expected.terminal_end);
    expect(sampleEnd).toBe(expectedEnd);
  });

  it("runs the inflated-call repair once per day", async () => {
    await resetDatabase();
    const now = Date.now();
    await execute(
      `INSERT INTO remote_calls (
         id, flight_key, idempotency_key, provider, path, status, outcome, started_at, ended_at
       ) VALUES ('old', 'flight-old', 'flight-old', 's2-clone', 'book', 'success', 'success', ?, ?)`,
      [now - 2 * 60 * 60_000, now]
    );
    expect(await repairInflatedRemoteCalls(now)).toEqual({ clamped: 0, closed: 0 });
    expect(remoteRepairSqlRunCount()).toBe(1);
    expect(await repairInflatedRemoteCalls(now + 60 * 60_000)).toEqual({
      clamped: 0,
      closed: 0,
    });
    expect(remoteRepairSqlRunCount()).toBe(1);
    expect(await repairInflatedRemoteCalls(now + REMOTE_REPAIR_INTERVAL_MS)).toEqual({
      clamped: 0,
      closed: 0,
    });
    expect(remoteRepairSqlRunCount()).toBe(2);
  });

  it("keeps book spend and an open call that started more than a day ago", async () => {
    await resetDatabase();
    resetRemoteLayerForTests();
    const now = Date.now();
    const cap = remoteCallCapMs();
    const hour = 60 * 60_000;
    await execute(
      `INSERT INTO remote_calls (
         id, flight_key, idempotency_key, provider, path, job_id, status, outcome,
         started_at, ended_at, est_cost_usd
       ) VALUES
         ('open-start', 's2-clone|book-open|0', 's2-clone|book-open|0', 's2-clone', 'book',
          'book-open', 'started', 'started', ?, NULL, 4),
         ('closed-start', 's2-clone|book-old|0', 's2-clone|book-old|0', 's2-clone', 'book',
          'book-old', 'started', 'started', ?, NULL, 20),
         ('closed-end', 's2-clone|book-old|0', 's2-clone|book-old|0', 's2-clone', 'book',
          'book-old', 'success', 'success', ?, ?, 20)`,
      [now - 30 * hour, now - 40 * hour, now - 40 * hour, now - 30 * hour]
    );

    await loadPersistedSpend();

    expect(bookSpend("book-old", now)).toEqual({ usd: 20, ms: cap });
    expect(dailySpend(now).ms).toBe(cap);
    expect(bookSpend("book-open", now).ms).toBe(cap);
    expect(bookSpend("book-open", now).usd).toBe(4);
  });
});

describe("harmless index plans", () => {
  it("searches prefix, email, rate-limit, and clip-day indexes", async () => {
    await resetDatabase();
    await execute(
      `INSERT INTO jobs (
         id, user_id, book_title, pdf_storage_path, status, job_kind
       ) VALUES ('job-1', 'user-a', 'Book', 'pdfs/upload-1/content.txt', 'ready', 'takehome')`
    );
    await execute(
      `INSERT INTO users (id, google_sub, email, email_verified, created_at)
       VALUES ('user_1', 'sub-1', 'Person@Example.com', 1, 1)`
    );
    await execute(`ANALYZE`);

    const bounds = storagePrefixBounds("pdfs/upload-1/");
    expectNoScan(
      await plan(
        `SELECT COUNT(*) AS total FROM jobs
         WHERE pdf_storage_path >= ? AND pdf_storage_path < ?`,
        [bounds.start, bounds.end]
      ),
      "jobs"
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

    resetRateLimitTableCache();
    const limit = createRateLimiter("plan", 5, 60_000);
    expect(await limit("reader")).toBe(true);
    expectNoScan(
      await plan(`DELETE FROM rate_limits WHERE window_start < ?`, [0]),
      "rate_limits"
    );

    expectNoScan(
      await plan(`SELECT COUNT(*) AS n FROM youtube_clips WHERE created_at >= ?`, [1]),
      "youtube_clips"
    );
  });
});
