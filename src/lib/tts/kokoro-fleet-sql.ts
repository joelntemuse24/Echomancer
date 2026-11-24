/**
 * Kokoro fleet membership, one equality per status and narrator.
 *
 * `status IN (...) AND tts_provider IN (...)` cannot use the status prefix
 * of `idx_jobs_kokoro_active`, so a lane-budget read walked every queued
 * and processing take-home. Each branch is an index range. The caller
 * repeats the job id (and, for rank, the created-at pair) once per branch.
 */

const STATUSES = ["queued", "processing"] as const;
const PROVIDERS = ["sowell", "drew", "george"] as const;

const DUE = `(sched_not_before IS NULL OR sched_not_before <= unixepoch())`;

function branches(extra: string): string {
  const parts: string[] = [];
  for (const status of STATUSES) {
    for (const provider of PROVIDERS) {
      parts.push(
        `SELECT id FROM jobs
         WHERE deleted_at IS NULL
           AND job_kind = 'takehome'
           AND id != ?
           AND status = '${status}'
           AND tts_provider = '${provider}'
           AND ${DUE}
           ${extra}`
      );
    }
  }
  return parts.join("\nUNION ALL\n");
}

export const KOKORO_FLEET_BRANCHES = STATUSES.length * PROVIDERS.length;

export function kokoroFleetCountSql(): string {
  return `SELECT COUNT(*) AS n FROM (
    ${branches("")}
  )`;
}

export function kokoroFleetCountArgs(jobId: string): string[] {
  return Array.from({ length: KOKORO_FLEET_BRANCHES }, () => jobId);
}

export function kokoroFleetRankSql(): string {
  return `SELECT COUNT(*) AS n FROM (
    ${branches(
      `AND (COALESCE(created_at, 0) < ?
            OR (COALESCE(created_at, 0) = ? AND id < ?))`
    )}
  )`;
}

export function kokoroFleetRankArgs(
  jobId: string,
  createdAt: number
): Array<string | number> {
  const args: Array<string | number> = [];
  for (let i = 0; i < KOKORO_FLEET_BRANCHES; i += 1) {
    args.push(jobId, createdAt, createdAt, jobId);
  }
  return args;
}
