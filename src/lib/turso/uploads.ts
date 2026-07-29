/**
 * Upload ownership records.
 *
 * `POST /api/jobs` accepts a `pdfStoragePath` from the browser, so the path
 * alone can never be trusted — these rows are what prove the calling session
 * actually uploaded that document.
 */
import { execute, queryOne } from "@/lib/turso";

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
}): Promise<void> {
  await execute(
    `INSERT INTO uploads (id, user_id, storage_path, source_path, file_name, format, byte_size, char_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.id,
      data.userId,
      data.storagePath,
      data.sourcePath ?? null,
      data.fileName ?? null,
      data.format ?? null,
      data.byteSize ?? 0,
      data.charCount ?? 0,
    ]
  );
}

export async function getUploadForUser(
  userId: string,
  storagePath: string
): Promise<UploadRow | null> {
  return queryOne<UploadRow>(
    `SELECT * FROM uploads WHERE storage_path = ? AND user_id = ? LIMIT 1`,
    [storagePath, userId]
  );
}
