/**
 * Upload ownership records.
 *
 * `POST /api/jobs` accepts a `pdfStoragePath` from the browser, so the path
 * alone can never be trusted — these rows are what prove the calling session
 * actually uploaded that document. Job create only accepts `status = 'ready'`
 * rows whose `storage_path` is the extracted `content.txt`.
 */
import { execute, queryOne } from "@/lib/turso";
import type { ExtractHost } from "@/lib/uploads/extract-route";

export type UploadStatus =
  | "pending"
  | "uploaded"
  | "extracting"
  | "ready"
  | "failed";

export interface UploadRow {
  id: string;
  user_id: string;
  storage_path: string;
  source_path: string | null;
  file_name: string | null;
  format: string | null;
  byte_size: number | null;
  char_count: number | null;
  created_at: number;
  status: UploadStatus | null;
  error_message: string | null;
  content_type: string | null;
  extract_started_at: number | null;
  /** `cloudflare` | `node` | `inline`. Null on rows from before Node extract. */
  extract_host?: string | null;
  extract_attempts?: number | null;
  /** Unix seconds of the first accept. Not refreshed by heartbeats. */
  extract_accepted_at?: number | null;
}

function asStatus(value: string | null | undefined): UploadStatus {
  if (
    value === "pending" ||
    value === "uploaded" ||
    value === "extracting" ||
    value === "ready" ||
    value === "failed"
  ) {
    return value;
  }
  return "ready";
}

export function uploadStatus(row: Pick<UploadRow, "status">): UploadStatus {
  return asStatus(row.status);
}

export async function recordUpload(data: {
  id: string;
  userId: string;
  storagePath: string;
  sourcePath?: string | null;
  fileName?: string | null;
  format?: string | null;
  byteSize?: number | null;
  charCount?: number | null;
  status?: UploadStatus;
  contentType?: string | null;
}): Promise<void> {
  await execute(
    `INSERT INTO uploads (
       id, user_id, storage_path, source_path, file_name, format,
       byte_size, char_count, status, content_type
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.id,
      data.userId,
      data.storagePath,
      data.sourcePath ?? null,
      data.fileName ?? null,
      data.format ?? null,
      data.byteSize ?? 0,
      data.charCount ?? 0,
      data.status ?? "ready",
      data.contentType ?? null,
    ]
  );
}

export async function insertPendingUpload(data: {
  id: string;
  userId: string;
  storagePath: string;
  sourcePath: string;
  fileName: string;
  format: string;
  byteSize: number;
  contentType: string;
}): Promise<void> {
  await recordUpload({
    ...data,
    charCount: 0,
    status: "pending",
  });
}

export async function getUploadById(id: string): Promise<UploadRow | null> {
  return queryOne<UploadRow>(`SELECT * FROM uploads WHERE id = ? LIMIT 1`, [
    id,
  ]);
}

export async function getUploadByIdForUser(
  userId: string,
  id: string
): Promise<UploadRow | null> {
  return queryOne<UploadRow>(
    `SELECT * FROM uploads WHERE id = ? AND user_id = ? LIMIT 1`,
    [id, userId]
  );
}

export async function getOwnedUploadByPath(
  userId: string,
  storagePath: string
): Promise<UploadRow | null> {
  return queryOne<UploadRow>(
    `SELECT * FROM uploads
     WHERE storage_path = ? AND user_id = ?
     LIMIT 1`,
    [storagePath, userId]
  );
}

export async function markUploadUploaded(id: string): Promise<void> {
  await execute(
    `UPDATE uploads
     SET status = 'uploaded', error_message = NULL
     WHERE id = ? AND status IN ('pending', 'uploaded')`,
    [id]
  );
}

/** GET re-nudge window while a row is still `uploaded`. */
export const EXTRACT_NUDGE_STALE_SECONDS = 20;

/** Re-dispatch a stuck `extracting` row (Worker / after() died). */
export const EXTRACT_EXTRACTING_STALE_SECONDS = 180;

/**
 * Atomically claim a GET re-nudge window. False when a recent dispatch
 * already owns the row — concurrent polls cannot both start extract.
 */
export async function claimUploadExtractNudge(
  id: string,
  staleSeconds = EXTRACT_NUDGE_STALE_SECONDS,
  extractingStaleSeconds = EXTRACT_EXTRACTING_STALE_SECONDS
): Promise<boolean> {
  const result = await execute(
    `UPDATE uploads
     SET extract_started_at = unixepoch()
     WHERE id = ?
       AND (
         (
           status = 'uploaded'
           AND (
             extract_started_at IS NULL
             OR extract_started_at <= unixepoch() - ?
           )
         )
         OR (
           status = 'extracting'
           AND extract_started_at IS NOT NULL
           AND extract_started_at <= unixepoch() - ?
         )
       )`,
    [id, staleSeconds, extractingStaleSeconds]
  );
  return result.rowsAffected > 0;
}

/**
 * Claim the row for `host`. Attempts accumulate across Node and Cloudflare
 * so a ping-pong between the two still hits the cap. `extract_accepted_at`
 * stays on the first accept. Returns false when the row is no longer
 * `uploaded` / `extracting`.
 */
export async function markUploadExtracting(
  id: string,
  host?: ExtractHost
): Promise<boolean> {
  if (!host) {
    const result = await execute(
      `UPDATE uploads
       SET status = 'extracting', extract_started_at = unixepoch(), error_message = NULL
       WHERE id = ? AND status IN ('uploaded', 'extracting')`,
      [id]
    );
    return result.rowsAffected > 0;
  }
  const result = await execute(
    `UPDATE uploads
     SET status = 'extracting',
         error_message = NULL,
         extract_host = ?,
         extract_attempts = COALESCE(extract_attempts, 0) + 1,
         extract_accepted_at = COALESCE(extract_accepted_at, unixepoch()),
         extract_started_at = unixepoch()
     WHERE id = ? AND status IN ('uploaded', 'extracting')`,
    [host, id]
  );
  return result.rowsAffected > 0;
}

/**
 * Compare-and-swap the heartbeat so two status polls cannot both dispatch.
 * `expectedStartedAt` null matches a row that has never been claimed.
 */
export async function claimExtractAdvance(
  id: string,
  expectedStartedAt: number | null
): Promise<boolean> {
  const started = expectedStartedAt == null ? -1 : expectedStartedAt;
  const result = await execute(
    `UPDATE uploads
     SET extract_started_at = unixepoch()
     WHERE id = ?
       AND status IN ('uploaded', 'extracting')
       AND (
         (? = -1 AND extract_started_at IS NULL)
         OR extract_started_at = ?
       )`,
    [id, started, started]
  );
  return result.rowsAffected > 0;
}

/** Parent process, while a Node extract child is queued or running. */
export async function heartbeatUploadExtract(id: string): Promise<void> {
  await execute(
    `UPDATE uploads
     SET extract_started_at = unixepoch()
     WHERE id = ? AND status = 'extracting' AND extract_host = 'node'`,
    [id]
  );
}

export async function finishUploadExtract(
  id: string,
  data: { charCount: number; host?: ExtractHost | null }
): Promise<void> {
  if (data.host) {
    await execute(
      `UPDATE uploads
       SET status = 'ready', char_count = ?, error_message = NULL, extract_started_at = NULL
       WHERE id = ? AND status = 'extracting'
         AND (extract_host IS NULL OR extract_host = ?)`,
      [data.charCount, id, data.host]
    );
    return;
  }
  await execute(
    `UPDATE uploads
     SET status = 'ready', char_count = ?, error_message = NULL, extract_started_at = NULL
     WHERE id = ? AND status = 'extracting'`,
    [data.charCount, id]
  );
}

export async function failUploadExtract(
  id: string,
  message: string,
  host?: ExtractHost | string | null
): Promise<void> {
  if (host) {
    await execute(
      `UPDATE uploads
       SET status = 'failed', error_message = ?
       WHERE id = ? AND status != 'ready'
         AND (extract_host IS NULL OR extract_host = ?)`,
      [message, id, host]
    );
    return;
  }
  await execute(
    `UPDATE uploads
     SET status = 'failed', error_message = ?
     WHERE id = ? AND status != 'ready'`,
    [message, id]
  );
}

