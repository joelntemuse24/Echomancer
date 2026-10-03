/**
 * Upload ownership records.
 *
 * `POST /api/jobs` accepts a `pdfStoragePath` from the browser, so the path
 * alone can never be trusted — these rows are what prove the calling session
 * actually uploaded that document. Take-home jobs may be created while the
 * row is still `uploaded`/`extracting`; the worker waits for the text.
 */
import { execute, queryOne } from "@/lib/turso";

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
  extract_attempts: number | null;
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

/**
 * Upload row for a storage path with no user filter. Only for paths that
 * already came back owner-checked (a job row the session owns); the row
 * itself is still never treated as proof of ownership.
 */
export async function getUploadByStoragePath(
  storagePath: string
): Promise<UploadRow | null> {
  return queryOne<UploadRow>(
    `SELECT * FROM uploads WHERE storage_path = ? LIMIT 1`,
    [storagePath]
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

export async function markUploadExtracting(id: string): Promise<void> {
  await execute(
    `UPDATE uploads
     SET status = 'extracting', extract_started_at = unixepoch(), error_message = NULL,
         extract_attempts = COALESCE(extract_attempts, 0) + 1
     WHERE id = ? AND status IN ('uploaded', 'extracting')`,
    [id]
  );
}

export async function finishUploadExtract(
  id: string,
  data: { charCount: number }
): Promise<void> {
  await execute(
    `UPDATE uploads
     SET status = 'ready', char_count = ?, error_message = NULL, extract_started_at = NULL
     WHERE id = ? AND status = 'extracting'`,
    [data.charCount, id]
  );
}

export async function failUploadExtract(
  id: string,
  message: string
): Promise<void> {
  await execute(
    `UPDATE uploads
     SET status = 'failed', error_message = ?
     WHERE id = ? AND status != 'ready'`,
    [message, id]
  );
}

