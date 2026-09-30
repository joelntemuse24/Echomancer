/**
 * Async job helpers using Turso (Edge SQLite)
 * Job CRUD against Turso (libSQL).
 */
import { execute } from "@/lib/turso";

export interface JobUpdateData {
  status?: "queued" | "processing" | "ready" | "failed";
  progress?: number;
  current_section?: number;
  total_sections?: number;
  audio_storage_path?: string;
  duration_seconds?: number;
  error_message?: string | null;
}

export async function updateJob(jobId: string, data: JobUpdateData): Promise<void> {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (data.status !== undefined) {
    fields.push("status = ?");
    values.push(data.status);
  }
  if (data.progress !== undefined) {
    fields.push("progress = ?");
    values.push(data.progress);
  }
  if (data.current_section !== undefined) {
    fields.push("current_section = ?");
    values.push(data.current_section);
  }
  if (data.total_sections !== undefined) {
    fields.push("total_sections = ?");
    values.push(data.total_sections);
  }
  if (data.audio_storage_path !== undefined) {
    fields.push("audio_storage_path = ?");
    values.push(data.audio_storage_path);
  }
  if (data.duration_seconds !== undefined) {
    fields.push("duration_seconds = ?");
    values.push(data.duration_seconds);
  }
  if (data.error_message !== undefined) {
    fields.push("error_message = ?");
    values.push(data.error_message);
  }

  fields.push("updated_at = unixepoch()");

  if (fields.length === 1) return;

  const sql = `UPDATE jobs SET ${fields.join(", ")} WHERE id = ?`;
  values.push(jobId);

  await execute(sql, values);
}

export async function deleteJob(jobId: string): Promise<void> {
  await execute(`UPDATE jobs SET deleted_at = unixepoch() WHERE id = ?`, [jobId]);
}

/**
 * Append an accounting row. Never throws: usage logging is observability, and
 * losing a row must not fail a job that has already produced audio (older
 * databases predate the `usage_logs` table entirely).
 */
export async function logUsage(data: {
  userId?: string | null;
  action: string;
  charsProcessed?: number;
  durationSeconds?: number;
}): Promise<void> {
  try {
    await execute(
      `INSERT INTO usage_logs (user_id, action, chars_processed, duration_seconds)
       VALUES (?, ?, ?, ?)`,
      [
        data.userId || "anonymous",
        data.action,
        data.charsProcessed || 0,
        data.durationSeconds || null,
      ]
    );
  } catch (err) {
    console.warn(
      `[usage] failed to log ${data.action}:`,
      err instanceof Error ? err.message : err
    );
  }
}
