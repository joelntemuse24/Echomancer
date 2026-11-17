/**
 * Best-effort copy of the remote-call log. A missing table or a locked
 * database never refuses synthesis. The worker reads the open rows back
 * on startup so a restarted process still knows a call is live.
 */

import { execute, query } from "@/lib/turso";
import {
  hydrateRemoteFlight,
  replacePersistedSpend,
  type Flight,
  type RemoteEvent,
  type SpendRow,
} from "@/lib/remote/layer";

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
         status = excluded.status,
         ended_at = excluded.ended_at,
         outcome = excluded.outcome,
         call_id = COALESCE(excluded.call_id, remote_calls.call_id),
         call_tag = COALESCE(excluded.call_tag, remote_calls.call_tag),
         error = excluded.error`,
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
    await loadPersistedSpend();
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
    }>(
      `SELECT flight_key, idempotency_key, provider, path, job_id, section_key,
              call_id, call_tag, outcome, started_at, est_cost_usd
       FROM remote_calls
       WHERE rowid IN (SELECT MAX(rowid) FROM remote_calls GROUP BY flight_key)
         AND outcome IN ('started', 'still_live')`
    );
    for (const row of rows) {
      const startedAt = asMs(Number(row.started_at)) || now;
      hydrateRemoteFlight({
        key: row.flight_key,
        idempotencyKey: row.idempotency_key,
        provider: row.provider,
        path: row.path,
        jobId: row.job_id ?? undefined,
        sections: row.section_key ? row.section_key.split(",").filter(Boolean) : [],
        status: row.outcome === "still_live" ? "still_live" : "running",
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

/** Dollars and wall-clock spans from persisted `started` rows. */
export async function loadPersistedSpend(): Promise<void> {
  const rows = await query<{
    flight_key: string;
    job_id: string | null;
    est_cost_usd: number | null;
    started_at: number;
    ended_at: number | null;
  }>(
    `SELECT s.flight_key, s.job_id, s.est_cost_usd, s.started_at,
            COALESCE(
              (SELECT MAX(e.ended_at) FROM remote_calls e
                WHERE e.flight_key = s.flight_key AND e.ended_at IS NOT NULL),
              s.started_at
            ) AS ended_at
     FROM remote_calls s
     WHERE s.outcome = 'started'`
  );
  const loaded: SpendRow[] = rows.map((row) => {
    const start = asMs(Number(row.started_at));
    const end = asMs(Number(row.ended_at)) || start;
    return {
      key: row.flight_key,
      jobId: row.job_id ?? undefined,
      usd: Number(row.est_cost_usd ?? 0),
      start,
      end: end > start ? end : start,
    };
  });
  replacePersistedSpend(loaded);
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
