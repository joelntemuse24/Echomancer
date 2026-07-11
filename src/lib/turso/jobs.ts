/**
 * Async job helpers using Turso (Edge SQLite)
 * Drop-in replacements for the sync better-sqlite3 versions
 */
import { queryOne, execute, query } from "@/lib/turso";
import type { MossAbVariant } from "@/lib/tts-config";

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

export async function getJob(jobId: string) {
  const row = await queryOne<{
    id: string;
    user_id: string;
    book_title: string;
    pdf_storage_path: string;
    voice_storage_path: string | null;
    voice_name: string | null;
    video_id: string | null;
    start_time: number;
    end_time: number;
    status: string;
    progress: number;
    current_section: number;
    total_sections: number;
    audio_storage_path: string | null;
    duration_seconds: number | null;
    error_message: string | null;
    tts_variant: MossAbVariant | null;
    char_count: number | null;
    paragraph_count: number | null;
    voice_clips: string | null;
    style_selection_seed: number | null;
    synthesis_contract: string | null;
    created_at: number;
    updated_at: number;
  }>(`SELECT * FROM jobs WHERE id = ? AND deleted_at IS NULL`, [jobId]);

  return row;
}

export async function deleteJob(jobId: string): Promise<void> {
  await execute(`UPDATE jobs SET deleted_at = unixepoch() WHERE id = ?`, [jobId]);
}

export async function resetJob(jobId: string): Promise<void> {
  await execute(
    `UPDATE jobs SET status = 'queued', progress = 0, current_section = 0,
     error_message = NULL, deleted_at = NULL, updated_at = unixepoch()
     WHERE id = ?`,
    [jobId]
  );
}

export async function recordJobTtsVariant(
  jobId: string,
  variant: MossAbVariant
): Promise<void> {
  await execute(
    `UPDATE jobs SET tts_variant = ?, updated_at = unixepoch() WHERE id = ?`,
    [variant, jobId]
  );
}

export async function logUsage(data: {
  userId?: string;
  action: string;
  charsProcessed?: number;
  durationSeconds?: number;
}): Promise<void> {
  await execute(
    `INSERT INTO usage_logs (user_id, action, chars_processed, duration_seconds)
     VALUES (?, ?, ?, ?)`,
    [data.userId || "anonymous", data.action, data.charsProcessed || 0, data.durationSeconds || null]
  );
}
