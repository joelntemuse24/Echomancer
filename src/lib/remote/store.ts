/**
 * Best-effort copy of the remote-call log. A missing table or a locked
 * database never refuses synthesis. The worker reads the open rows back
 * on startup so a restarted process still knows a call is live.
 */

import { execute, query } from "@/lib/turso";
import {
  countsTowardGpuBudget,
  hydrateRemoteFlight,
  REMOTE_DAY_MS,
  remoteCallCapMs,
  replacePersistedSpend,
  type Flight,
  type RemoteEvent,
  type SpendRow,
} from "@/lib/remote/layer";

/**
 * Latest row of each flight that started inside the call cap. Grouping
 * the whole history made every startup and hourly reconcile read every
 * `remote_calls` row. The outcome filter stays outside the group so a
 * newer terminal row still hides an older open row for the same flight.
 */
export const OPEN_REMOTE_CALLS_SQL = `SELECT flight_key, idempotency_key, provider, path, job_id, section_key,
              call_id, call_tag, outcome, started_at, est_cost_usd
       FROM remote_calls
       WHERE rowid IN (
         SELECT MAX(rowid) FROM remote_calls
         WHERE started_at >= ?
         GROUP BY flight_key
       )
         AND outcome IN ('started', 'still_live', 'submit_unconfirmed')
         AND (
           ended_at IS NULL
           OR outcome IN ('still_live', 'submit_unconfirmed')
         )`;

function asMs(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 10_000_000_000 ? n : n * 1000;
}

export async function persistRemoteEvent(event: RemoteEvent): Promise<void> {
  try {
    await execute(
      `INSERT INTO remote_calls (
         id, flight_key, idempotency_key, provider, path, job_id, section_key,
         call_id, call_tag, status, started_at, ended_at, outcome, est_cost_usd, error
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = CASE
           WHEN remote_calls.outcome IN ('success', 'failure', 'cancelled', 'timeout', 'abandoned')
           THEN remote_calls.status
           ELSE excluded.status
         END,
         ended_at = CASE
           WHEN remote_calls.ended_at IS NOT NULL
            AND remote_calls.outcome IN ('success', 'failure', 'cancelled', 'timeout', 'abandoned')
           THEN remote_calls.ended_at
           ELSE COALESCE(excluded.ended_at, remote_calls.ended_at)
         END,
         outcome = CASE
           WHEN remote_calls.outcome IN ('success', 'failure', 'cancelled', 'timeout', 'abandoned')
           THEN remote_calls.outcome
           ELSE excluded.outcome
         END,
         call_id = COALESCE(excluded.call_id, remote_calls.call_id),
         call_tag = COALESCE(excluded.call_tag, remote_calls.call_tag),
         error = CASE
           WHEN remote_calls.outcome IN ('success', 'failure', 'cancelled', 'timeout', 'abandoned')
           THEN remote_calls.error
           ELSE excluded.error
         END`,
      [
        event.id,
        event.flightKey,
        event.idempotencyKey,
        event.provider,
        event.path,
        event.jobId ?? null,
        event.section ?? null,
        event.callId ?? null,
        event.callTag ?? null,
        event.outcome,
        Math.floor(event.startedAt),
        event.endedAt ? Math.floor(event.endedAt) : null,
        event.outcome,
        event.estCostUsd ?? null,
        event.error ?? null,
      ]
    );
  } catch (err) {
    console.warn(
      "[remote] event was not stored:",
      err instanceof Error ? err.message : err
    );
  }
}

export async function hydrateOpenRemoteCalls(now = Date.now()): Promise<number> {
  try {
    await loadPersistedSpend(now);
    // Latest row per flight_key. An older terminal row must not hide a
    // later still_live for the same sections.
    const rows = await query<{
      flight_key: string;
      idempotency_key: string;
      provider: Flight["provider"];
      path: Flight["path"];
      job_id: string | null;
      section_key: string | null;
      call_id: string | null;
      call_tag: string | null;
      outcome: string;
      started_at: number;
      est_cost_usd: number | null;
    }>(OPEN_REMOTE_CALLS_SQL, [now - remoteCallCapMs() - 60_000]);
    for (const row of rows) {
      const startedAt = asMs(Number(row.started_at)) || now;
      hydrateRemoteFlight({
        key: row.flight_key,
        idempotencyKey: row.idempotency_key,
        provider: row.provider,
        path: row.path,
        jobId: row.job_id ?? undefined,
        sections: row.section_key ? row.section_key.split(",").filter(Boolean) : [],
        status:
          row.outcome === "still_live"
            ? "still_live"
            : row.outcome === "submit_unconfirmed"
              ? "submit_unconfirmed"
              : "running",
        callId: row.call_id ?? undefined,
        tag: row.call_tag ?? undefined,
        startedAt,
        estCostUsd: Number(row.est_cost_usd ?? 0),
        estMs: Math.max(0, now - startedAt),
      });
    }
    return rows.length;
  } catch (err) {
    console.warn(
      "[remote] open calls were not loaded:",
      err instanceof Error ? err.message : err
    );
    return 0;
  }
}

/**
 * Dollars and wall-clock spans from persisted `started` rows.
 * The end is the earliest terminal end for that flight, so a later cleanup
 * pass that writes a newer `ended_at` cannot stretch the charge. A row the
 * repair marked abandoned is closed. A call that is still open is not.
 *
 * The two lookups are correlated, but each one is an index range on
 * `(flight_key, outcome, ended_at)` or `(flight_key, ended_at)`. The outer
 * row is limited to the trailing day so a startup does not walk every
 * historical `started` row. Without those indexes each lookup scanned the
 * whole table once per started row.
 */
export const PERSISTED_SPEND_SQL = `SELECT s.flight_key, s.job_id, s.provider, s.path, s.est_cost_usd, s.started_at,
            s.status AS status,
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
     WHERE s.outcome = 'started'
       AND s.started_at >= ?`;

/**
 * Clamp only ends written inside the trailing day. `ended_at >= ?` is an
 * index range on `idx_remote_calls_ended`. The old predicate compared two
 * columns and scanned every `remote_calls` row.
 */
export const REPAIR_INFLATED_REMOTE_CALLS_SQL = `UPDATE remote_calls
       SET ended_at = started_at + ?,
           status = CASE
             WHEN outcome IN ('started', 'still_live', 'submit_unconfirmed') THEN 'abandoned'
             ELSE status
           END
       WHERE ended_at IS NOT NULL
         AND ended_at >= ?
         AND started_at > 0
         AND ended_at > started_at + ?`;

export async function loadPersistedSpend(now = Date.now()): Promise<void> {
  const rows = await query<{
    flight_key: string;
    job_id: string | null;
    provider: SpendRow["provider"];
    path: SpendRow["path"];
    est_cost_usd: number | null;
    started_at: number;
    status: string | null;
    terminal_end: number | null;
    any_end: number | null;
  }>(PERSISTED_SPEND_SQL, [now - REMOTE_DAY_MS]);
  const loaded: SpendRow[] = rows.map((row) => {
    const start = asMs(Number(row.started_at));
    const terminal = asMs(Number(row.terminal_end));
    const anyEnd = asMs(Number(row.any_end));
    // A terminal end, or the repair that marks the row abandoned, is final.
    // An open call keeps accruing until that happens; a provisional
    // still_live end must not freeze the charge below the real run.
    const closed = terminal > start || row.status === "abandoned";
    const end = terminal > start ? terminal : anyEnd > start ? anyEnd : start;
    const provider = row.provider;
    const path = row.path ?? "book";
    return {
      key: row.flight_key,
      jobId: row.job_id ?? undefined,
      provider,
      path,
      gpu: provider ? countsTowardGpuBudget(provider, path) : true,
      usd: Number(row.est_cost_usd ?? 0),
      start,
      end: end > start ? end : start,
      closed,
    };
  });
  replacePersistedSpend(loaded);
}

/** One repair per day per process. Reconcile used to run the scan every hour. */
export const REMOTE_REPAIR_INTERVAL_MS = REMOTE_DAY_MS;

let lastRemoteRepairAt = Number.NEGATIVE_INFINITY;
let remoteRepairSqlRuns = 0;

/** Test seam: allow the next repair to touch the database. */
export function resetRemoteRepairCache(): void {
  lastRemoteRepairAt = Number.NEGATIVE_INFINITY;
  remoteRepairSqlRuns = 0;
}

/** Test seam: how many times the repair statements actually ran. */
export function remoteRepairSqlRunCount(): number {
  return remoteRepairSqlRuns;
}

/**
 * Idempotent repair for rows whose end was pushed forward by a later
 * cleanup pass. Both statements are UPDATEs: the first rewrites only spans
 * longer than the per-call cap whose end sits in the trailing day, the
 * second closes only open rows already older than that cap. A non-terminal
 * row whose end was slid is marked abandoned, so the spend load treats that
 * clamped span as closed instead of extending it to now. A call admitted
 * now matches neither. Nothing is deleted. A second pass inside the day
 * writes no SQL.
 */
export async function repairInflatedRemoteCalls(
  now = Date.now()
): Promise<{ clamped: number; closed: number }> {
  if (now < lastRemoteRepairAt + REMOTE_REPAIR_INTERVAL_MS) {
    return { clamped: 0, closed: 0 };
  }
  const cap = remoteCallCapMs();
  const cutoff = now - cap;
  try {
    remoteRepairSqlRuns += 1;
    const clamped = await execute(
      REPAIR_INFLATED_REMOTE_CALLS_SQL,
      [cap, now - REMOTE_DAY_MS, cap]
    );
    const closed = await execute(
      `UPDATE remote_calls
       SET ended_at = started_at + ?,
           status = 'abandoned',
           outcome = CASE
             WHEN outcome = 'started' THEN 'started'
             ELSE 'abandoned'
           END
       WHERE outcome IN ('started', 'still_live', 'submit_unconfirmed')
         AND started_at > 0
         AND started_at <= ?
         AND (ended_at IS NULL OR ended_at <= started_at)`,
      [cap, cutoff]
    );
    const clampedN = clamped.rowsAffected;
    const closedN = closed.rowsAffected;
    if (clampedN > 0 || closedN > 0) {
      console.info(
        `[remote] repaired remote calls clamped=${clampedN} closed=${closedN} cap_ms=${cap}`
      );
    }
    lastRemoteRepairAt = now;
    return { clamped: clampedN, closed: closedN };
  } catch (err) {
    console.warn(
      "[remote] repair failed:",
      err instanceof Error ? err.message : err
    );
    return { clamped: 0, closed: 0 };
  }
}

/** Write the function-call id onto the latest row without a second spend reservation. */
export async function stampOpenRemoteCall(flight: {
  key: string;
  callId?: string;
  tag?: string;
}): Promise<void> {
  try {
    await execute(
      `UPDATE remote_calls
       SET call_id = COALESCE(?, call_id),
           call_tag = COALESCE(?, call_tag)
       WHERE rowid = (SELECT MAX(rowid) FROM remote_calls WHERE flight_key = ?)`,
      [flight.callId ?? null, flight.tag ?? null, flight.key]
    );
  } catch (err) {
    console.warn(
      "[remote] call id was not stored:",
      err instanceof Error ? err.message : err
    );
  }
}

export async function saveActiveBrake(app: string, savedMax: number): Promise<void> {
  try {
    await execute(
      `INSERT INTO remote_brake (app, saved_max, active, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(app) DO UPDATE SET
         saved_max = excluded.saved_max,
         active = 1,
         updated_at = excluded.updated_at`,
      [app, Math.floor(savedMax), Date.now()]
    );
  } catch (err) {
    console.warn(
      "[remote] brake was not stored:",
      err instanceof Error ? err.message : err
    );
  }
}

export async function clearActiveBrake(app: string): Promise<void> {
  try {
    await execute(`UPDATE remote_brake SET active = 0, updated_at = ? WHERE app = ?`, [
      Date.now(),
      app,
    ]);
  } catch (err) {
    console.warn(
      "[remote] brake clear failed:",
      err instanceof Error ? err.message : err
    );
  }
}

export async function loadActiveBrakes(): Promise<Array<{ app: string; savedMax: number }>> {
  const rows = await query<{ app: string; saved_max: number }>(
    `SELECT app, saved_max FROM remote_brake WHERE active = 1`
  );
  return rows.map((row) => ({ app: row.app, savedMax: Number(row.saved_max) }));
}
