/**
 * One live take-home per user, upload, and narrator.
 *
 * The old check was SELECT-then-INSERT. Two overlapping creates both saw
 * no row and both inserted. A UNIQUE index on `jobs` cannot be added while
 * those historical pairs still exist, and a permanent unique key would also
 * block a legitimate new book after the previous one failed or was cancelled.
 *
 * `takehome_create_keys` points at the canonical live job. Startup backfill
 * stores the oldest live row and leaves every extra row in place. A failed
 * or cancelled job releases the key so the next create may insert again.
 */

import { execute, queryOne } from "@/lib/turso";

export const LIVE_TAKEHOME_STATUSES = [
  "queued",
  "waiting",
  "processing",
  "ready",
] as const;

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS takehome_create_keys (
  idem_key TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  committed INTEGER NOT NULL DEFAULT 0,
  reserved_until INTEGER NOT NULL DEFAULT 0
)`;

let tableReady = false;

export function takehomeIdemKey(input: {
  userId: string;
  pdfStoragePath: string;
  ttsProvider: string;
  catalogVoiceId?: string | null;
  providerVoiceId?: string | null;
}): string {
  return [
    input.userId,
    input.pdfStoragePath,
    input.ttsProvider,
    input.catalogVoiceId ?? "",
    input.providerVoiceId ?? "",
  ].join("\u001f");
}

async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await execute(CREATE_SQL);
  tableReady = true;
}

export function resetTakehomeIdentityCache(): void {
  tableReady = false;
}

interface KeyRow {
  job_id: string;
  committed: number;
  reserved_until: number;
}

interface LiveJob {
  id: string;
  status: string;
}

async function readKey(key: string): Promise<KeyRow | null> {
  return queryOne<KeyRow>(
    `SELECT job_id, committed, reserved_until FROM takehome_create_keys WHERE idem_key = ?`,
    [key]
  );
}

async function liveJob(id: string): Promise<LiveJob | null> {
  return queryOne<LiveJob>(
    `SELECT id, status FROM jobs
     WHERE id = ? AND deleted_at IS NULL
       AND job_kind = 'takehome'
       AND status IN ('queued', 'waiting', 'processing', 'ready')`,
    [id]
  );
}

async function oldestLiveJob(input: {
  userId: string;
  pdfStoragePath: string;
  ttsProvider: string;
  catalogVoiceId?: string | null;
  providerVoiceId?: string | null;
}): Promise<LiveJob | null> {
  return queryOne<LiveJob>(
    `SELECT id, status FROM jobs
     WHERE user_id = ? AND pdf_storage_path = ? AND job_kind = 'takehome'
       AND deleted_at IS NULL
       AND COALESCE(tts_provider, '') = ?
       AND COALESCE(catalog_voice_id, '') = ?
       AND COALESCE(provider_voice_id, '') = ?
       AND status IN ('queued', 'waiting', 'processing', 'ready')
     ORDER BY created_at ASC, id ASC
     LIMIT 1`,
    [
      input.userId,
      input.pdfStoragePath,
      input.ttsProvider,
      input.catalogVoiceId ?? "",
      input.providerVoiceId ?? "",
    ]
  );
}

export type TakehomeCreateOpen =
  | { action: "use"; jobId: string; status: string }
  | { action: "insert"; jobId: string; idemKey: string };

/**
 * Reserve the right to insert, or return the live job that already owns
 * this book. Historical duplicates stay; the oldest is the one returned.
 */
export async function beginTakehomeCreate(input: {
  userId: string;
  pdfStoragePath: string;
  ttsProvider: string;
  catalogVoiceId?: string | null;
  providerVoiceId?: string | null;
  jobId: string;
}): Promise<TakehomeCreateOpen> {
  await ensureTable();
  const key = takehomeIdemKey(input);

  const bound = await canonicalLive(key, input);
  if (bound) return { action: "use", jobId: bound.id, status: bound.status };

  const reserved = await execute(
    `INSERT INTO takehome_create_keys (idem_key, job_id, committed, reserved_until)
     SELECT ?, ?, 0, unixepoch() + 30
     WHERE NOT EXISTS (
       SELECT 1 FROM takehome_create_keys WHERE idem_key = ?
     )`,
    [key, input.jobId, key]
  );
  if (reserved.rowsAffected > 0) {
    return { action: "insert", jobId: input.jobId, idemKey: key };
  }

  const stolen = await execute(
    `UPDATE takehome_create_keys
     SET job_id = ?, committed = 0, reserved_until = unixepoch() + 30
     WHERE idem_key = ?
       AND committed = 0
       AND reserved_until <= unixepoch()
       AND NOT EXISTS (
         SELECT 1 FROM jobs
         WHERE id = takehome_create_keys.job_id
           AND deleted_at IS NULL
           AND job_kind = 'takehome'
           AND status IN ('queued', 'waiting', 'processing', 'ready')
       )`,
    [input.jobId, key]
  );
  if (stolen.rowsAffected > 0) {
    return { action: "insert", jobId: input.jobId, idemKey: key };
  }

  const again = await canonicalLive(key, input);
  if (again) return { action: "use", jobId: again.id, status: again.status };

  const replaced = await replaceTerminalKey(key, input.jobId);
  if (replaced) return { action: "insert", jobId: input.jobId, idemKey: key };

  const finalLive = await canonicalLive(key, input);
  if (finalLive) return { action: "use", jobId: finalLive.id, status: finalLive.status };

  // The other create is between reserve and commit. One pause, not a poll.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const settled = await canonicalLive(key, input);
  if (settled) return { action: "use", jobId: settled.id, status: settled.status };

  throw new TakehomeCreateBusyError();
}

export class TakehomeCreateBusyError extends Error {
  constructor() {
    super("Take-home create is already in progress. Try again.");
    this.name = "TakehomeCreateBusyError";
  }
}

async function canonicalLive(
  key: string,
  input: {
    userId: string;
    pdfStoragePath: string;
    ttsProvider: string;
    catalogVoiceId?: string | null;
    providerVoiceId?: string | null;
  }
): Promise<LiveJob | null> {
  const row = await readKey(key);
  if (row) {
    const pointed = await liveJob(row.job_id);
    if (pointed) {
      // A crash after the job insert and before commit leaves the key
      // uncommitted. The row is already the book. Commit it instead of
      // letting the reservation expire into a second insert.
      if (Number(row.committed) !== 1) {
        await execute(
          `UPDATE takehome_create_keys
           SET committed = 1, reserved_until = 0
           WHERE idem_key = ? AND job_id = ? AND committed = 0`,
          [key, pointed.id]
        );
      }
      return pointed;
    }
  }
  const historical = await oldestLiveJob(input);
  if (!historical) return null;
  const inserted = await execute(
    `INSERT OR IGNORE INTO takehome_create_keys
       (idem_key, job_id, committed, reserved_until)
     VALUES (?, ?, 1, 0)`,
    [key, historical.id]
  );
  if (inserted.rowsAffected > 0) return historical;
  const winner = await readKey(key);
  if (!winner) return historical;
  const winnerJob = await liveJob(winner.job_id);
  if (winnerJob) return winnerJob;
  // The key names a job that is not live, and a live book already exists.
  // Bind the key to that book once the reservation is committed or expired.
  // A fresh reservation for a job that has not been inserted yet stays put.
  if (Number(winner.committed) === 1 || Number(winner.reserved_until) <= unixNow()) {
    const rebound = await execute(
      `UPDATE takehome_create_keys
       SET job_id = ?, committed = 1, reserved_until = 0
       WHERE idem_key = ? AND job_id = ?
         AND (
           committed = 1
           OR reserved_until <= unixepoch()
         )`,
      [historical.id, key, winner.job_id]
    );
    if (rebound.rowsAffected > 0) return historical;
  }
  return null;
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

async function replaceTerminalKey(key: string, jobId: string): Promise<boolean> {
  const row = await readKey(key);
  if (!row || Number(row.committed) !== 1) return false;
  const stillLive = await liveJob(row.job_id);
  if (stillLive) return false;
  const result = await execute(
    `UPDATE takehome_create_keys
     SET job_id = ?, committed = 0, reserved_until = unixepoch() + 30
     WHERE idem_key = ? AND job_id = ? AND committed = 1
       AND NOT EXISTS (
         SELECT 1 FROM jobs
         WHERE id = takehome_create_keys.job_id
           AND deleted_at IS NULL
           AND job_kind = 'takehome'
           AND status IN ('queued', 'waiting', 'processing', 'ready')
       )`,
    [jobId, key, row.job_id]
  );
  return result.rowsAffected > 0;
}

export async function commitTakehomeCreate(
  idemKey: string,
  jobId: string
): Promise<void> {
  await execute(
    `UPDATE takehome_create_keys
     SET committed = 1, reserved_until = 0
     WHERE idem_key = ? AND job_id = ? AND committed = 0`,
    [idemKey, jobId]
  );
}

export async function abortTakehomeCreate(
  idemKey: string,
  jobId: string
): Promise<void> {
  await execute(
    `DELETE FROM takehome_create_keys
     WHERE idem_key = ? AND job_id = ? AND committed = 0`,
    [idemKey, jobId]
  ).catch(() => undefined);
}

/**
 * Point each live duplicate group at its oldest job. Extra jobs are not
 * deleted, and a key that already exists is left alone. Safe to run twice.
 */
export async function backfillTakehomeCreateKeys(): Promise<number> {
  await ensureTable();
  const result = await execute(
    `INSERT OR IGNORE INTO takehome_create_keys
       (idem_key, job_id, committed, reserved_until)
     SELECT
       user_id || char(31) || pdf_storage_path || char(31) ||
         COALESCE(tts_provider, '') || char(31) ||
         COALESCE(catalog_voice_id, '') || char(31) ||
         COALESCE(provider_voice_id, ''),
       id,
       1,
       0
     FROM jobs AS j
     WHERE j.deleted_at IS NULL
       AND j.job_kind = 'takehome'
       AND j.status IN ('queued', 'waiting', 'processing', 'ready')
       AND j.id = (
         SELECT j2.id FROM jobs AS j2
         WHERE j2.deleted_at IS NULL
           AND j2.job_kind = 'takehome'
           AND j2.status IN ('queued', 'waiting', 'processing', 'ready')
           AND j2.user_id = j.user_id
           AND j2.pdf_storage_path = j.pdf_storage_path
           AND COALESCE(j2.tts_provider, '') = COALESCE(j.tts_provider, '')
           AND COALESCE(j2.catalog_voice_id, '') = COALESCE(j.catalog_voice_id, '')
           AND COALESCE(j2.provider_voice_id, '') = COALESCE(j.provider_voice_id, '')
         ORDER BY j2.created_at ASC, j2.id ASC
         LIMIT 1
       )`
  );
  return result.rowsAffected;
}
