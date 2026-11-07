/**
 * Who may be claimed next.
 *
 * Ordering by `jobs.updated_at` round-robins a single user's books, because
 * a yielded book is touched and goes to the back, but that user's other
 * untouched books stay at the front. `takehome_fairness.last_served_at` is
 * the user clock. Same-user ties still use `updated_at`, so the existing
 * yield order inside one library is unchanged.
 *
 * The in-flight cap defaults to 1. With `WORKER_CONCURRENCY=1` only one
 * book runs, so the cap does not change that host. A second worker cannot
 * give one user every slot.
 */

import { execute } from "@/lib/turso";

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS takehome_fairness (
  user_id TEXT PRIMARY KEY,
  last_served_at INTEGER NOT NULL
)`;

let tableReady = false;

export function takehomeInflightCap(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env.TAKEHOME_MAX_INFLIGHT_PER_USER;
  if (raw === undefined || raw.trim() === "") return 1;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  if (n <= 0) return 0;
  return Math.min(100, Math.floor(n));
}

/**
 * Cluster-wide synthesis leases. This is not the CPU fleet and not a
 * provider account cap. `0` disables it. The default is a finite budget,
 * not "one book".
 */
export function takehomeGlobalActiveCap(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env.TAKEHOME_GLOBAL_ACTIVE;
  if (raw === undefined || raw.trim() === "") return 16;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 16;
  if (n <= 0) return 0;
  return Math.min(200, Math.floor(n));
}

/**
 * Predicates shared by the drain list and the claim UPDATE.
 * A book with `sched_not_before` in the future is waiting on CPU or a
 * full provider cap and must not be claimed again immediately.
 */
export function takehomeAdmissionSql(
  perUser = takehomeInflightCap(),
  globalCap = takehomeGlobalActiveCap()
): { sql: string; args: number[] } {
  const parts = [
    ` AND (jobs.sched_not_before IS NULL OR jobs.sched_not_before <= unixepoch())`,
  ];
  const args: number[] = [];
  if (perUser > 0) {
    parts.push(` AND (
           SELECT COUNT(*) FROM jobs AS busy
           WHERE busy.user_id = jobs.user_id
             AND busy.deleted_at IS NULL
             AND busy.job_kind = 'takehome'
             AND busy.status = 'processing'
             AND busy.lease_expires_at IS NOT NULL
             AND busy.lease_expires_at > unixepoch()
             AND busy.id != jobs.id
         ) < ?`);
    args.push(perUser);
  }
  if (globalCap > 0) {
    parts.push(` AND (
           SELECT COUNT(*) FROM jobs AS fleet
           WHERE fleet.deleted_at IS NULL
             AND fleet.job_kind = 'takehome'
             AND fleet.status = 'processing'
             AND fleet.lease_expires_at IS NOT NULL
             AND fleet.lease_expires_at > unixepoch()
             AND fleet.id != jobs.id
         ) < ?`);
    args.push(globalCap);
  }
  return { sql: parts.join(""), args };
}

async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await execute(CREATE_SQL);
  tableReady = true;
}

export function resetTakehomeFairnessCache(): void {
  tableReady = false;
}

/** Record that this job's user just received the worker. Failures are ignored. */
export async function markTakehomeServed(jobId: string): Promise<void> {
  try {
    await ensureTable();
    await execute(
      `INSERT INTO takehome_fairness (user_id, last_served_at)
       SELECT user_id, unixepoch() FROM jobs WHERE id = ?
       ON CONFLICT(user_id) DO UPDATE SET last_served_at = excluded.last_served_at`,
      [jobId]
    );
  } catch (err) {
    console.warn(
      "[takehome-fairness] mark served failed",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Extra predicates and the order by clause for the drain.
 * `cap` 0 disables the per-user processing limit.
 */
export function takehomeClaimSql(cap: number): {
  filter: string;
  order: string;
  args: number[];
} {
  const admission = takehomeAdmissionSql(cap, takehomeGlobalActiveCap());
  return {
    filter: admission.sql,
    order: ` ORDER BY COALESCE(
           (SELECT last_served_at FROM takehome_fairness AS fair
            WHERE fair.user_id = jobs.user_id),
           0
         ) ASC, jobs.updated_at ASC`,
    args: admission.args,
  };
}
