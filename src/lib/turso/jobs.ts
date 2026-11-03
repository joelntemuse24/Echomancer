/**
 * Async job helpers using Turso (Edge SQLite)
 * Job CRUD against Turso (libSQL).
 */
import { execute } from "@/lib/turso";

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
