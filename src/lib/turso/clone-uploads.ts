/**
 * Pending clone-sample ownership. The browser PUTs to `clones/<id>/…`;
 * complete reads that object and creates the `cloned_voices` row.
 */
import { execute, queryOne } from "@/lib/turso";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";

export type CloneUploadStatus =
  | "pending"
  | "uploaded"
  | "completed"
  | "failed";

export interface CloneUploadRow {
  id: string;
  user_id: string;
  sample_storage_path: string;
  file_name: string | null;
  content_type: string | null;
  byte_size: number | null;
  status: CloneUploadStatus | null;
  error_message: string | null;
  cloned_voice_id: string | null;
  created_at: number;
}

function asStatus(value: string | null | undefined): CloneUploadStatus {
  if (
    value === "pending" ||
    value === "uploaded" ||
    value === "completed" ||
    value === "failed"
  ) {
    return value;
  }
  return "pending";
}

export function cloneUploadStatus(
  row: Pick<CloneUploadRow, "status">
): CloneUploadStatus {
  return asStatus(row.status);
}

export async function insertPendingCloneUpload(data: {
  id: string;
  userId: string;
  sampleStoragePath: string;
  fileName: string;
  contentType: string;
  byteSize: number;
}): Promise<void> {
  await ensureTtsJobColumns();
  await execute(
    `INSERT INTO clone_uploads (
       id, user_id, sample_storage_path, file_name, content_type, byte_size, status
     )
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    [
      data.id,
      data.userId,
      data.sampleStoragePath,
      data.fileName,
      data.contentType,
      data.byteSize,
    ]
  );
}

export async function getCloneUploadByIdForUser(
  userId: string,
  id: string
): Promise<CloneUploadRow | null> {
  await ensureTtsJobColumns();
  return queryOne<CloneUploadRow>(
    `SELECT * FROM clone_uploads WHERE id = ? AND user_id = ? LIMIT 1`,
    [id, userId]
  );
}

export async function markCloneUploadUploaded(id: string): Promise<void> {
  await ensureTtsJobColumns();
  await execute(
    `UPDATE clone_uploads
     SET status = 'uploaded', error_message = NULL
     WHERE id = ? AND status IN ('pending', 'uploaded')`,
    [id]
  );
}

export async function markCloneUploadCompleted(
  id: string,
  clonedVoiceId: string
): Promise<void> {
  await ensureTtsJobColumns();
  await execute(
    `UPDATE clone_uploads
     SET status = 'completed', cloned_voice_id = ?, error_message = NULL
     WHERE id = ?`,
    [clonedVoiceId, id]
  );
}

export async function markCloneUploadFailed(
  id: string,
  message: string
): Promise<void> {
  await ensureTtsJobColumns();
  await execute(
    `UPDATE clone_uploads
     SET status = 'failed', error_message = ?
     WHERE id = ? AND status NOT IN ('completed')`,
    [message, id]
  );
}
