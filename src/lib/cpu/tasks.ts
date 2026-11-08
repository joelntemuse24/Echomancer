/**
 * Durable CPU work. The row is the contract between the take-home
 * orchestrator and a CPU worker (this machine, or a Modal CPU container).
 * Input and output are object keys. Nothing here assumes a shared temp
 * directory.
 *
 * Claim steals only an expired lease. A live owner is not matched again,
 * so two workers cannot hold one task. Completion is owner-fenced.
 */

import { execute, queryOne } from "@/lib/turso";

export const CPU_TASK_MAX_ATTEMPTS = 3;
export const CPU_TASK_LEASE_SECONDS = 90;

export type CpuTaskKind = "master" | "whisper" | "concat" | "extract";
export type CpuTaskStatus = "queued" | "claimed" | "done" | "failed" | "cancelled";

export interface CpuTaskRow {
  id: string;
  kind: CpuTaskKind;
  job_id: string | null;
  upload_id: string | null;
  section_index: number | null;
  status: CpuTaskStatus;
  owner_token: string | null;
  lease_expires_at: number | null;
  attempts: number;
  input_path: string | null;
  output_path: string | null;
  payload_json: string | null;
  error_message: string | null;
  created_at?: number | null;
  updated_at?: number | null;
  /** Unix time the orchestrator placed this attempt. */
  placed_at?: number | null;
  /** Unix time the owner first heartbeated. Queue wait ends here. */
  started_at?: number | null;
  /** Unix time the task reached a terminal status. */
  finished_at?: number | null;
  /** Unix time the work itself must stop. Independent of the placement lease. */
  deadline_at?: number | null;
}

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS cpu_tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  job_id TEXT,
  upload_id TEXT,
  section_index INTEGER,
  status TEXT NOT NULL,
  owner_token TEXT,
  lease_expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  input_path TEXT,
  output_path TEXT,
  payload_json TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  placed_at INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  deadline_at INTEGER
)`;

const INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_cpu_tasks_status ON cpu_tasks (status, created_at)`;

const JOB_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_cpu_tasks_job ON cpu_tasks (job_id, status)`;

const LEASE_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_cpu_tasks_lease ON cpu_tasks (status, lease_expires_at)`;

const CPU_TASK_COLUMNS = [
  "placed_at INTEGER",
  "started_at INTEGER",
  "finished_at INTEGER",
  "deadline_at INTEGER",
];

let tableReady = false;

export function resetCpuTaskTableCache(): void {
  tableReady = false;
}

export async function ensureCpuTaskTable(): Promise<void> {
  if (tableReady) return;
  await execute("PRAGMA busy_timeout = 5000").catch(() => {});
  await execute(CREATE_SQL);
  for (const column of CPU_TASK_COLUMNS) {
    try {
      await execute(`ALTER TABLE cpu_tasks ADD COLUMN ${column}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column/i.test(msg)) throw err;
    }
  }
  await execute(INDEX_SQL);
  await execute(JOB_INDEX_SQL);
  await execute(LEASE_INDEX_SQL);
  tableReady = true;
}

export async function enqueueCpuTask(input: {
  id: string;
  kind: CpuTaskKind;
  jobId?: string | null;
  uploadId?: string | null;
  sectionIndex?: number | null;
  inputPath?: string | null;
  outputPath?: string | null;
  payload?: unknown;
}): Promise<void> {
  await ensureCpuTaskTable();
  const payload = input.payload == null ? null : JSON.stringify(input.payload);
  await execute(
    `INSERT INTO cpu_tasks (
       id, kind, job_id, upload_id, section_index, status,
       input_path, output_path, payload_json, attempts, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, 0, unixepoch(), unixepoch())
     ON CONFLICT(id) DO UPDATE SET
       input_path = excluded.input_path,
       output_path = excluded.output_path,
       payload_json = excluded.payload_json,
       status = CASE
         WHEN cpu_tasks.attempts >= ? AND cpu_tasks.input_path = excluded.input_path THEN 'failed'
         ELSE 'queued'
       END,
       owner_token = NULL,
       lease_expires_at = NULL,
       error_message = CASE
         WHEN cpu_tasks.attempts >= ? AND cpu_tasks.input_path = excluded.input_path
           THEN COALESCE(cpu_tasks.error_message, 'cpu attempts exhausted')
         ELSE NULL
       END,
       attempts = CASE
         WHEN cpu_tasks.input_path = excluded.input_path THEN cpu_tasks.attempts
         ELSE 0
       END,
       finished_at = CASE
         WHEN cpu_tasks.attempts >= ? AND cpu_tasks.input_path = excluded.input_path
           THEN COALESCE(cpu_tasks.finished_at, unixepoch())
         ELSE NULL
       END,
       updated_at = unixepoch()
     WHERE (cpu_tasks.status != 'done' OR cpu_tasks.input_path != excluded.input_path)
       AND (cpu_tasks.status != 'claimed' OR cpu_tasks.lease_expires_at <= unixepoch())
       AND cpu_tasks.status != 'failed'
       AND cpu_tasks.status != 'cancelled'`,
    [
      input.id,
      input.kind,
      input.jobId ?? null,
      input.uploadId ?? null,
      input.sectionIndex ?? null,
      input.inputPath ?? null,
      input.outputPath ?? null,
      payload,
      CPU_TASK_MAX_ATTEMPTS,
      CPU_TASK_MAX_ATTEMPTS,
      CPU_TASK_MAX_ATTEMPTS,
    ]
  );
}

export async function getCpuTask(id: string): Promise<CpuTaskRow | null> {
  await ensureCpuTaskTable();
  return queryOne<CpuTaskRow>(`SELECT * FROM cpu_tasks WHERE id = ?`, [id]);
}

export async function claimCpuTask(
  id: string,
  ownerToken: string,
  ttlSeconds = CPU_TASK_LEASE_SECONDS,
  deadlineSeconds?: number | null
): Promise<boolean> {
  await ensureCpuTaskTable();
  const deadline = deadlineSeconds == null ? null : deadlineSeconds;
  const result = await execute(
    `UPDATE cpu_tasks SET
       status = 'claimed',
       owner_token = ?,
       lease_expires_at = unixepoch() + ?,
       attempts = attempts + 1,
       placed_at = COALESCE(placed_at, unixepoch()),
       deadline_at = CASE WHEN ? IS NULL THEN deadline_at ELSE unixepoch() + ? END,
       finished_at = NULL,
       updated_at = unixepoch()
     WHERE id = ?
       AND attempts < ?
       AND (
         status = 'queued'
         OR (status = 'claimed' AND lease_expires_at <= unixepoch())
       )`,
    [ownerToken, ttlSeconds, deadline, deadline, id, CPU_TASK_MAX_ATTEMPTS]
  );
  return result.rowsAffected === 1;
}

/** True when this id is claimed and the lease has not expired. */
export async function cpuTaskLeaseLive(id: string): Promise<boolean> {
  await ensureCpuTaskTable();
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM cpu_tasks
     WHERE id = ? AND status = 'claimed'
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at > unixepoch()`,
    [id]
  );
  return Number(row?.n || 0) > 0;
}

export async function heartbeatCpuTask(
  id: string,
  ownerToken: string,
  ttlSeconds = CPU_TASK_LEASE_SECONDS
): Promise<boolean> {
  await ensureCpuTaskTable();
  const result = await execute(
    `UPDATE cpu_tasks SET
       lease_expires_at = unixepoch() + ?,
       started_at = COALESCE(started_at, unixepoch()),
       updated_at = unixepoch()
     WHERE id = ?
       AND owner_token = ?
       AND status = 'claimed'
       AND lease_expires_at > unixepoch()`,
    [ttlSeconds, id, ownerToken]
  );
  return result.rowsAffected === 1;
}

export async function completeCpuTask(id: string, ownerToken: string): Promise<boolean> {
  await ensureCpuTaskTable();
  const result = await execute(
    `UPDATE cpu_tasks SET
       status = 'done',
       owner_token = NULL,
       lease_expires_at = NULL,
       error_message = NULL,
       finished_at = unixepoch(),
       updated_at = unixepoch()
     WHERE id = ? AND owner_token = ? AND status = 'claimed'`,
    [id, ownerToken]
  );
  return result.rowsAffected === 1;
}

/**
 * The platform refused the placement. The claim's attempt increment is
 * undone and the row goes back to `queued` with the reason kept. A
 * disabled workspace is not an execution attempt.
 */
export async function releaseCpuPlacement(
  id: string,
  ownerToken: string,
  message: string
): Promise<void> {
  await ensureCpuTaskTable();
  await execute(
    `UPDATE cpu_tasks SET
       status = 'queued',
       owner_token = NULL,
       lease_expires_at = NULL,
       attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
       error_message = ?,
       updated_at = unixepoch()
     WHERE id = ? AND owner_token = ? AND status = 'claimed'`,
    [message.slice(0, 500), id, ownerToken]
  );
}

/**
 * A completed HTTP error that is not a disabled workspace. The placement
 * was not accepted, so the attempt increment is undone, and the row is
 * `failed` so the next caller does not POST it again.
 */
export async function rejectCpuPlacement(
  id: string,
  ownerToken: string,
  message: string
): Promise<void> {
  await ensureCpuTaskTable();
  await execute(
    `UPDATE cpu_tasks SET
       status = 'failed',
       owner_token = NULL,
       lease_expires_at = NULL,
       attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
       error_message = ?,
       finished_at = unixepoch(),
       updated_at = unixepoch()
     WHERE id = ? AND owner_token = ? AND status = 'claimed'`,
    [message.slice(0, 500), id, ownerToken]
  );
}

/**
 * A queued row that already spent its attempts is not runnable. Normalize
 * it to `failed` and keep `finished_at`. A live claim is left alone.
 */
export async function normalizeExhaustedCpuTask(id: string): Promise<void> {
  await ensureCpuTaskTable();
  await execute(
    `UPDATE cpu_tasks SET
       status = 'failed',
       owner_token = NULL,
       lease_expires_at = NULL,
       error_message = COALESCE(error_message, 'cpu attempts exhausted'),
       finished_at = COALESCE(finished_at, unixepoch()),
       updated_at = unixepoch()
     WHERE id = ?
       AND attempts >= ?
       AND status NOT IN ('done', 'cancelled', 'failed')
       AND (status != 'claimed' OR lease_expires_at <= unixepoch())`,
    [id, CPU_TASK_MAX_ATTEMPTS]
  );
}

/**
 * Explicit repair of one raw master. Not used by enqueue. A `done` row
 * is not reopened. Caller has already verified the raw object.
 */
export async function reopenCpuTaskForRaw(input: {
  id: string;
  kind: CpuTaskKind;
  jobId: string;
  sectionIndex?: number | null;
  inputPath: string;
  outputPath: string;
  payload?: unknown;
}): Promise<void> {
  await ensureCpuTaskTable();
  const payload = input.payload == null ? null : JSON.stringify(input.payload);
  const existing = await getCpuTask(input.id);
  if (!existing) {
    await enqueueCpuTask({
      id: input.id,
      kind: input.kind,
      jobId: input.jobId,
      sectionIndex: input.sectionIndex ?? null,
      inputPath: input.inputPath,
      outputPath: input.outputPath,
      payload: input.payload,
    });
    return;
  }
  if (existing.status === "done" || existing.status === "cancelled") return;
  await execute(
    `UPDATE cpu_tasks SET
       status = 'queued',
       owner_token = NULL,
       lease_expires_at = NULL,
       attempts = 0,
       error_message = NULL,
       started_at = NULL,
       finished_at = NULL,
       placed_at = NULL,
       input_path = ?,
       output_path = ?,
       payload_json = ?,
       updated_at = unixepoch()
     WHERE id = ?
       AND status NOT IN ('done', 'cancelled')
       AND (status != 'claimed' OR lease_expires_at <= unixepoch())`,
    [input.inputPath, input.outputPath, payload, input.id]
  );
}

/** Saturation is not a failed attempt. The claim's attempt increment is undone. */
export async function requeueCpuTask(id: string, ownerToken: string): Promise<void> {
  await ensureCpuTaskTable();
  await execute(
    `UPDATE cpu_tasks SET
       status = 'queued',
       owner_token = NULL,
       lease_expires_at = NULL,
       attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
       updated_at = unixepoch()
     WHERE id = ? AND owner_token = ? AND status = 'claimed'`,
    [id, ownerToken]
  );
}

export async function failCpuTask(
  id: string,
  ownerToken: string,
  message: string
): Promise<void> {
  await ensureCpuTaskTable();
  await execute(
    `UPDATE cpu_tasks SET
       status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'queued' END,
       owner_token = NULL,
       lease_expires_at = NULL,
       error_message = ?,
       finished_at = CASE WHEN attempts >= ? THEN unixepoch() ELSE NULL END,
       updated_at = unixepoch()
     WHERE id = ? AND owner_token = ? AND status = 'claimed'`,
    [CPU_TASK_MAX_ATTEMPTS, message.slice(0, 500), CPU_TASK_MAX_ATTEMPTS, id, ownerToken]
  );
}

export async function cancelCpuTask(id: string, ownerToken: string): Promise<void> {
  await ensureCpuTaskTable();
  await execute(
    `UPDATE cpu_tasks SET
       status = 'cancelled',
       owner_token = NULL,
       lease_expires_at = NULL,
       finished_at = unixepoch(),
       updated_at = unixepoch()
     WHERE id = ? AND owner_token = ? AND status = 'claimed'`,
    [id, ownerToken]
  );
}

export async function cancelCpuTasksForJob(jobId: string): Promise<void> {
  await ensureCpuTaskTable();
  await execute(
    `UPDATE cpu_tasks SET
       status = 'cancelled',
       owner_token = NULL,
       lease_expires_at = NULL,
       updated_at = unixepoch()
     WHERE job_id = ? AND status IN ('queued', 'claimed', 'failed')`,
    [jobId]
  );
}

/**
 * A claimed task whose lease expired had no heartbeat. Put it back, or
 * fail it once the attempt budget is spent. A live owner is not touched,
 * so a container that is still heartbeating cannot be duplicated.
 */
export async function requeueExpiredCpuTasks(): Promise<number> {
  await ensureCpuTaskTable();
  const result = await execute(
    `UPDATE cpu_tasks SET
       status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'queued' END,
       owner_token = NULL,
       lease_expires_at = NULL,
       error_message = CASE
         WHEN attempts >= ? THEN COALESCE(error_message, 'cpu lease expired')
         ELSE error_message
       END,
       finished_at = CASE WHEN attempts >= ? THEN COALESCE(finished_at, unixepoch()) ELSE finished_at END,
       updated_at = unixepoch()
     WHERE status = 'claimed'
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at <= unixepoch()`,
    [CPU_TASK_MAX_ATTEMPTS, CPU_TASK_MAX_ATTEMPTS, CPU_TASK_MAX_ATTEMPTS]
  );
  return result.rowsAffected;
}

export function cpuTaskId(kind: CpuTaskKind, subject: string, index?: number): string {
  if (index == null) return `${kind}:${subject}`;
  return `${kind}:${subject}:${index}`;
}
