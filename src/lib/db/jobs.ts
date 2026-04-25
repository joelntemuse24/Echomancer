import { db } from "./index";

export interface JobUpdateData {
  status?: "queued" | "processing" | "ready" | "failed";
  progress?: number;
  current_section?: number;
  total_sections?: number;
  audio_storage_path?: string;
  duration_seconds?: number;
  error_message?: string | null;
}

/**
 * Update a job's status and progress
 */
export function updateJob(jobId: string, data: JobUpdateData): void {
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

  // Always update updated_at
  fields.push("updated_at = unixepoch()");

  if (fields.length === 1) return; // Only updated_at, no actual changes

  const sql = `UPDATE jobs SET ${fields.join(", ")} WHERE id = ?`;
  values.push(jobId);

  const stmt = db.prepare(sql);
  stmt.run(...values);
}

/**
 * Get a job by ID
 */
export function getJob(jobId: string) {
  const stmt = db.prepare(`SELECT * FROM jobs WHERE id = ? AND deleted_at IS NULL`);
  return stmt.get(jobId) as {
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
    created_at: number;
    updated_at: number;
  } | undefined;
}

/**
 * Delete (soft delete) a job
 */
export function deleteJob(jobId: string): void {
  const stmt = db.prepare(`UPDATE jobs SET deleted_at = unixepoch() WHERE id = ?`);
  stmt.run(jobId);
}

/**
 * Reset a job for retry
 */
export function resetJob(jobId: string): void {
  const stmt = db.prepare(`
    UPDATE jobs 
    SET status = 'queued', 
        progress = 0, 
        current_section = 0,
        error_message = NULL,
        deleted_at = NULL,
        updated_at = unixepoch()
    WHERE id = ?
  `);
  stmt.run(jobId);
}

/**
 * Log usage
 */
export function logUsage(data: {
  userId?: string;
  action: string;
  charsProcessed?: number;
  durationSeconds?: number;
}): void {
  const stmt = db.prepare(`
    INSERT INTO usage_logs (user_id, action, chars_processed, duration_seconds)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(
    data.userId || "anonymous",
    data.action,
    data.charsProcessed || 0,
    data.durationSeconds || null
  );
}
