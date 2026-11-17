/**
 * Best-effort copy of the remote-call log. A missing table or a locked
 * database never refuses synthesis. The worker reads the open rows back
 * on startup so a restarted process still knows a call is live.
 */

import { execute, query } from "@/lib/turso";
import { hydrateRemoteFlight, type Flight, type RemoteEvent } from "@/lib/remote/layer";

export async function persistRemoteEvent(event: RemoteEvent): Promise<void> {
  try {
    await execute(
      `INSERT INTO remote_calls (
         id, flight_key, idempotency_key, provider, path, job_id, section_key,
         call_id, status, started_at, ended_at, outcome, est_cost_usd, error
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         ended_at = excluded.ended_at,
         outcome = excluded.outcome,
         call_id = COALESCE(excluded.call_id, remote_calls.call_id),
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
        event.outcome,
        Math.floor(event.startedAt / 1000),
        event.endedAt ? Math.floor(event.endedAt / 1000) : null,
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
    const rows = await query<{
      flight_key: string;
      idempotency_key: string;
      provider: Flight["provider"];
      path: Flight["path"];
      job_id: string | null;
      section_key: string | null;
      call_id: string | null;
      outcome: string;
      started_at: number;
      est_cost_usd: number | null;
    }>(
      `SELECT flight_key, idempotency_key, provider, path, job_id, section_key,
              call_id, outcome, started_at, est_cost_usd
       FROM remote_calls
       WHERE outcome IN ('started', 'still_live')
         AND flight_key NOT IN (
           SELECT flight_key FROM remote_calls
           WHERE outcome IN ('success', 'failure', 'cancelled', 'timeout')
         )`
    );
    for (const row of rows) {
      hydrateRemoteFlight({
        key: row.flight_key,
        idempotencyKey: row.idempotency_key,
        provider: row.provider,
        path: row.path,
        jobId: row.job_id ?? undefined,
        sections: row.section_key ? row.section_key.split(",").filter(Boolean) : [],
        status: row.outcome === "still_live" ? "still_live" : "running",
        callId: row.call_id ?? undefined,
        startedAt: Number(row.started_at) > 10_000_000_000 ? Number(row.started_at) : Number(row.started_at) * 1000,
        estCostUsd: Number(row.est_cost_usd ?? 0),
        estMs: Math.max(0, now - Number(row.started_at) * 1000),
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
