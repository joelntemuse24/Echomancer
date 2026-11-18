/**
 * Last listening position for one person and one book.
 * Rows follow `jobs.user_id`. An anonymous session owns its place until
 * sign-in moves that browser's library.
 */

import { execute, query, queryOne } from "@/lib/turso";

export interface PlaybackPosition {
  positionSeconds: number;
  sectionIndex: number | null;
  updatedAt: number;
}

interface PositionRow {
  job_id?: string;
  position_seconds: number;
  section_index: number | null;
  updated_at: number;
}

function toPosition(row: PositionRow): PlaybackPosition {
  return {
    positionSeconds: Number(row.position_seconds),
    sectionIndex: row.section_index == null ? null : Number(row.section_index),
    updatedAt: Number(row.updated_at),
  };
}

export async function getPlaybackPosition(
  userId: string,
  jobId: string
): Promise<PlaybackPosition | null> {
  const row = await queryOne<PositionRow>(
    `SELECT position_seconds, section_index, updated_at
     FROM playback_positions
     WHERE user_id = ? AND job_id = ?`,
    [userId, jobId]
  );
  return row ? toPosition(row) : null;
}

export async function listPlaybackPositions(
  userId: string,
  jobIds: readonly string[]
): Promise<Map<string, PlaybackPosition>> {
  const out = new Map<string, PlaybackPosition>();
  if (jobIds.length === 0) return out;
  const marks = jobIds.map(() => "?").join(", ");
  const rows = await query<PositionRow & { job_id: string }>(
    `SELECT job_id, position_seconds, section_index, updated_at
     FROM playback_positions
     WHERE user_id = ? AND job_id IN (${marks})`,
    [userId, ...jobIds]
  );
  for (const row of rows) {
    if (row.job_id) out.set(row.job_id, toPosition(row));
  }
  return out;
}

export type PlaybackWrite =
  | { accepted: true; position: PlaybackPosition }
  | { accepted: false; position: PlaybackPosition };

/**
 * Compare-and-swap on `updated_at`. A tab that last read an older row
 * cannot replace a position another device has written since.
 * `force` is a seek or a part change on this device: the listener moved
 * the playhead, so that write replaces the row.
 */
export async function upsertPlaybackPosition(input: {
  userId: string;
  jobId: string;
  positionSeconds: number;
  sectionIndex: number | null;
  expectedUpdatedAt: number | null;
  force: boolean;
}): Promise<PlaybackWrite> {
  const updated = await execute(
    `UPDATE playback_positions
     SET position_seconds = ?, section_index = ?,
         updated_at = MAX(unixepoch(), playback_positions.updated_at + 1)
     WHERE user_id = ? AND job_id = ?
       AND (? = 1 OR updated_at = ?)`,
    [
      input.positionSeconds,
      input.sectionIndex,
      input.userId,
      input.jobId,
      input.force ? 1 : 0,
      input.expectedUpdatedAt,
    ]
  );
  if (updated.rowsAffected > 0) {
    const position = await getPlaybackPosition(input.userId, input.jobId);
    if (!position) throw new Error("Playback position was not stored");
    return { accepted: true, position };
  }
  const inserted = await execute(
    `INSERT INTO playback_positions (
       user_id, job_id, position_seconds, section_index, updated_at
     )
     SELECT ?, ?, ?, ?, unixepoch()
     WHERE NOT EXISTS (
       SELECT 1 FROM playback_positions WHERE user_id = ? AND job_id = ?
     )`,
    [
      input.userId,
      input.jobId,
      input.positionSeconds,
      input.sectionIndex,
      input.userId,
      input.jobId,
    ]
  );
  const position = await getPlaybackPosition(input.userId, input.jobId);
  if (!position) throw new Error("Playback position was not stored");
  if (inserted.rowsAffected > 0) return { accepted: true, position };
  return { accepted: false, position };
}
