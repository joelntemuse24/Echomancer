/**
 * Whether another audiobook object must not be stored for this job.
 * A missing row is left to the caller: concat tests and a few
 * backfills have no jobs row, and a soft-deleted book keeps its row.
 */
import { queryOne } from "@/lib/turso";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";

export async function jobAudiobookClosed(jobId: string): Promise<boolean> {
  if (!jobId) return true;
  await ensureTtsJobColumns();
  const row = await queryOne<{ deleted_at: number | null; status: string }>(
    `SELECT deleted_at, status FROM jobs WHERE id = ?`,
    [jobId]
  );
  if (!row) return false;
  return row.deleted_at != null || row.status === "cancelled";
}
