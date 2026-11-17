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

export async function upsertPlaybackPosition(input: {
  userId: string;
  jobId: string;
  positionSeconds: number;
  sectionIndex: number | null;
}): Promise<PlaybackPosition> {
  await execute(
    `INSERT INTO playback_positions (
       user_id, job_id, position_seconds, section_index, updated_at
     ) VALUES (?, ?, ?, ?, unixepoch())
     ON CONFLICT(user_id, job_id) DO UPDATE SET
       position_seconds = excluded.position_seconds,
       section_index = excluded.section_index,
       updated_at = excluded.updated_at`,
    [input.userId, input.jobId, input.positionSeconds, input.sectionIndex]
  );
  const row = await getPlaybackPosition(input.userId, input.jobId);
  if (!row) throw new Error("Playback position was not stored");
  return row;
}
