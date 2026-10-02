/**
 * youtube_clips rows. A claim is one UPDATE … RETURNING. LibSQL has no
 * SELECT … FOR UPDATE SKIP LOCKED; the status predicate makes a second
 * claim of the same row affect zero rows.
 */

import { execute, query, queryOne } from "@/lib/turso";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import {
  appDailyApifyUsd,
  clipOverBudget,
  utcDayStartSec,
  type ClipErrorCode,
} from "@/lib/youtube/clip-policy";

export type ClipStatus = "queued" | "running" | "ready" | "failed";

export type YoutubeClipRow = {
  id: string;
  user_id: string;
  video_id: string;
  start_seconds: number;
  length_seconds: number;
  status: ClipStatus;
  error_code: string | null;
  bytes_proxy: number;
  apify_run_id: string | null;
  apify_usd: number;
  r2_key: string | null;
  consent_at: number;
  attempts: number;
  created_at: number;
  finished_at: number | null;
  phase: string | null;
  /** Source video length from videos.list at queue time. Null on older rows. */
  video_seconds: number | null;
  /** Display name chosen from the video title. Null on older rows. */
  title: string | null;
};

export async function insertYoutubeClip(row: {
  id: string;
  userId: string;
  videoId: string;
  startSeconds: number;
  lengthSeconds: number;
  consentAt: number;
  videoSeconds?: number | null;
  title?: string | null;
}): Promise<void> {
  await ensureTtsJobColumns();
  const now = Math.floor(Date.now() / 1000);
  const title = row.title?.trim() || null;
  await execute(
    `INSERT INTO youtube_clips (
       id, user_id, video_id, start_seconds, length_seconds, status,
       bytes_proxy, consent_at, attempts, created_at, video_seconds, title
     ) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, 0, ?, ?, ?)`,
    [
      row.id,
      row.userId,
      row.videoId,
      row.startSeconds,
      row.lengthSeconds,
      row.consentAt,
      now,
      row.videoSeconds != null && Number.isFinite(row.videoSeconds) ? row.videoSeconds : null,
      title,
    ]
  );
}

export async function getYoutubeClipForUser(
  userId: string,
  id: string
): Promise<YoutubeClipRow | null> {
  await ensureTtsJobColumns();
  return queryOne<YoutubeClipRow>(
    `SELECT * FROM youtube_clips WHERE id = ? AND user_id = ? LIMIT 1`,
    [id, userId]
  );
}

export async function clipBudgetExceeded(
  userId: string,
  now = Date.now(),
  pendingUsd = 0
): Promise<boolean> {
  await ensureTtsJobColumns();
  const day = utcDayStartSec(now);
  const counts = await queryOne<{ user_count: number; app_count: number }>(
    `SELECT
       SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS user_count,
       COUNT(*) AS app_count
     FROM youtube_clips WHERE created_at >= ?`,
    [userId, day]
  );
  const spent = await queryOne<{ user_bytes: number; app_bytes: number; app_usd: number }>(
    `SELECT
       COALESCE(SUM(CASE WHEN user_id = ? THEN bytes_proxy ELSE 0 END), 0) AS user_bytes,
       COALESCE(SUM(bytes_proxy), 0) AS app_bytes,
       COALESCE(SUM(apify_usd), 0) AS app_usd
     FROM youtube_clips WHERE created_at >= ?`,
    [userId, day]
  );
  return clipOverBudget({
    userCount: Number(counts?.user_count || 0),
    appCount: Number(counts?.app_count || 0),
    userBytes: Number(spent?.user_bytes || 0),
    appBytes: Number(spent?.app_bytes || 0),
    appUsd: Number(spent?.app_usd || 0) + Math.max(0, pendingUsd),
    usdLimit: appDailyApifyUsd(),
  });
}

/** Claim the oldest queued row, or null when the queue is empty. */
export async function claimYoutubeClip(): Promise<YoutubeClipRow | null> {
  await ensureTtsJobColumns();
  const rows = await query<YoutubeClipRow>(
    `UPDATE youtube_clips
     SET status = 'running', attempts = attempts + 1
     WHERE id = (
       SELECT id FROM youtube_clips
       WHERE status = 'queued' AND attempts < 2
       ORDER BY created_at ASC
       LIMIT 1
     )
     AND status = 'queued'
     RETURNING *`
  );
  return rows[0] ?? null;
}

/** fetching while Apify runs, preparing once the file is local. */
export async function setYoutubeClipPhase(
  id: string,
  phase: "fetching" | "preparing"
): Promise<void> {
  await execute(`UPDATE youtube_clips SET phase = ? WHERE id = ?`, [phase, id]).catch(() => {});
}

export async function finishYoutubeClip(input: {
  id: string;
  status: "ready" | "failed" | "queued";
  errorCode?: ClipErrorCode | null;
  bytesProxy: number;
  r2Key?: string | null;
  apifyRunId?: string | null;
  apifyUsd?: number;
}): Promise<void> {
  const done = input.status === "queued" ? null : Math.floor(Date.now() / 1000);
  await execute(
    `UPDATE youtube_clips
     SET status = ?, error_code = ?,
         phase = CASE WHEN ? = 'queued' THEN NULL ELSE phase END,
         bytes_proxy = bytes_proxy + ?,
         apify_usd = apify_usd + ?,
         apify_run_id = COALESCE(?, apify_run_id),
         r2_key = COALESCE(?, r2_key),
         finished_at = ?
     WHERE id = ?`,
    [
      input.status,
      input.errorCode ?? null,
      input.status,
      Math.max(0, Math.round(input.bytesProxy)),
      Number(input.apifyUsd || 0),
      input.apifyRunId ?? null,
      input.r2Key ?? null,
      done,
      input.id,
    ]
  );
}
