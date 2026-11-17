/**
 * Playhead marks for one listener and one book.
 * Rows follow `jobs.user_id`: an anonymous session owns its marks until
 * sign-in moves that browser's library.
 */

import { randomUUID } from "node:crypto";
import { execute, query, queryOne } from "@/lib/turso";
import {
  BOOKMARK_DEDUPE_SECONDS,
  type JobBookmark,
} from "@/lib/player/bookmarks";

interface BookmarkRow {
  id: string;
  position_seconds: number;
  section_index: number | null;
  label: string | null;
  created_at: number;
}

function toBookmark(row: BookmarkRow): JobBookmark {
  return {
    id: row.id,
    positionSeconds: Number(row.position_seconds),
    sectionIndex: row.section_index == null ? null : Number(row.section_index),
    label: row.label ?? null,
    createdAt: Number(row.created_at),
  };
}

const SELECT_COLUMNS = `id, position_seconds, section_index, label, created_at`;

export async function listBookmarks(userId: string, jobId: string): Promise<JobBookmark[]> {
  const rows = await query<BookmarkRow>(
    `SELECT ${SELECT_COLUMNS}
     FROM bookmarks
     WHERE user_id = ? AND job_id = ?
     ORDER BY CASE WHEN section_index IS NULL THEN -1 ELSE section_index END ASC,
              position_seconds ASC`,
    [userId, jobId]
  );
  return rows.map(toBookmark);
}

/**
 * The nearest mark on the same clock within {@link BOOKMARK_DEDUPE_SECONDS}.
 * A different part is a different clock, even at the same number of seconds.
 */
export async function findNearBookmark(
  userId: string,
  jobId: string,
  positionSeconds: number,
  sectionIndex: number | null
): Promise<JobBookmark | null> {
  const row = await queryOne<BookmarkRow>(
    `SELECT ${SELECT_COLUMNS}
     FROM bookmarks
     WHERE user_id = ? AND job_id = ?
       AND ABS(position_seconds - ?) <= ?
       AND (
         (? IS NULL AND section_index IS NULL)
         OR section_index = ?
       )
     ORDER BY ABS(position_seconds - ?) ASC
     LIMIT 1`,
    [
      userId,
      jobId,
      positionSeconds,
      BOOKMARK_DEDUPE_SECONDS,
      sectionIndex,
      sectionIndex,
      positionSeconds,
    ]
  );
  return row ? toBookmark(row) : null;
}

export async function insertBookmark(input: {
  userId: string;
  jobId: string;
  positionSeconds: number;
  sectionIndex: number | null;
  label: string | null;
}): Promise<JobBookmark> {
  const id = randomUUID();
  await execute(
    `INSERT INTO bookmarks (
       id, user_id, job_id, position_seconds, section_index, label, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, unixepoch())`,
    [
      id,
      input.userId,
      input.jobId,
      input.positionSeconds,
      input.sectionIndex,
      input.label,
    ]
  );
  const row = await queryOne<BookmarkRow>(
    `SELECT ${SELECT_COLUMNS} FROM bookmarks WHERE id = ? AND user_id = ? AND job_id = ?`,
    [id, input.userId, input.jobId]
  );
  if (!row) throw new Error("Bookmark was not stored");
  return toBookmark(row);
}

/** True when a row owned by this listener on this book was removed. */
export async function deleteBookmark(
  userId: string,
  jobId: string,
  bookmarkId: string
): Promise<boolean> {
  const result = await execute(
    `DELETE FROM bookmarks WHERE id = ? AND user_id = ? AND job_id = ?`,
    [bookmarkId, userId, jobId]
  );
  return result.rowsAffected > 0;
}
