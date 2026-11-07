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
  const unlimited = cap <= 0;
  return {
    filter: unlimited
      ? ""
      : ` AND (
           SELECT COUNT(*) FROM jobs AS busy
           WHERE busy.user_id = jobs.user_id
             AND busy.deleted_at IS NULL
             AND busy.job_kind = 'takehome'
             AND busy.status = 'processing'
             AND busy.lease_expires_at IS NOT NULL
             AND busy.lease_expires_at > unixepoch()
             AND busy.id != jobs.id
         ) < ?`,
    order: ` ORDER BY COALESCE(
           (SELECT last_served_at FROM takehome_fairness AS fair
            WHERE fair.user_id = jobs.user_id),
           0
         ) ASC, jobs.updated_at ASC`,
    args: unlimited ? [] : [cap],
  };
}
