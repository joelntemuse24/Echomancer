/**
 * youtube_clips rows. A claim is one UPDATE … RETURNING. LibSQL has no
 * SELECT … FOR UPDATE SKIP LOCKED; the status predicate makes a second
 * claim of the same row affect zero rows.
 */

import { randomUUID } from "node:crypto";
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
  lease_token: string | null;
  lease_expires_at: number | null;
  create_started_at: number | null;
  quality_json: string | null;
  accept_quality_risk: number;
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

export const CLIP_LEASE_SEC = 90;

/** Recover only expired leases; an uncertain paid create is never repeated. */
export async function recoverYoutubeClips(): Promise<void> {
  await ensureTtsJobColumns();
  await execute(`UPDATE youtube_clips SET
    status = CASE
      WHEN EXISTS (SELECT 1 FROM cloned_voices v WHERE v.id = youtube_clips.id AND v.user_id = youtube_clips.user_id AND v.deleted_at IS NULL) THEN 'ready'
      WHEN create_started_at IS NOT NULL OR attempts >= 2 THEN 'failed'
      ELSE 'queued' END,
    error_code = CASE WHEN EXISTS (SELECT 1 FROM cloned_voices v WHERE v.id = youtube_clips.id AND v.user_id = youtube_clips.user_id AND v.deleted_at IS NULL) THEN NULL
      WHEN create_started_at IS NOT NULL THEN 'provider_uncertain'
      WHEN attempts >= 2 THEN 'timeout' ELSE NULL END,
    finished_at = CASE WHEN create_started_at IS NOT NULL OR attempts >= 2 THEN unixepoch() ELSE NULL END,
    lease_token = NULL, lease_expires_at = NULL, phase = NULL
    WHERE status = 'running' AND COALESCE(lease_expires_at, 0) <= unixepoch()`);
  await execute(`UPDATE youtube_clips SET status = 'failed', error_code = 'timeout', finished_at = unixepoch()
    WHERE status = 'queued' AND attempts >= 2`);
}

export async function claimYoutubeClip(): Promise<YoutubeClipRow | null> {
  await recoverYoutubeClips();
  const rows = await query<YoutubeClipRow>(
    `UPDATE youtube_clips SET status = 'running', attempts = attempts + 1,
      lease_token = ?, lease_expires_at = unixepoch() + ?
     WHERE id = (SELECT id FROM youtube_clips WHERE status = 'queued' AND attempts < 2
       ORDER BY created_at ASC LIMIT 1) AND status = 'queued' RETURNING *`,
    [randomUUID(), CLIP_LEASE_SEC]
  );
  return rows[0] ?? null;
}

export async function heartbeatYoutubeClip(id: string, token: string): Promise<boolean> {
  const result = await execute(`UPDATE youtube_clips SET lease_expires_at = unixepoch() + ?
    WHERE id = ? AND lease_token = ? AND status = 'running' AND lease_expires_at > unixepoch()`,
    [CLIP_LEASE_SEC, id, token]);
  return result.rowsAffected === 1;
}

export async function setYoutubeClipPhase(
  id: string, phase: "fetching" | "preparing", token: string
): Promise<void> {
  const result = await execute(`UPDATE youtube_clips SET phase = ? WHERE id = ? AND lease_token = ?
    AND status = 'running' AND lease_expires_at > unixepoch()`, [phase, id, token]);
  if (!result.rowsAffected) throw new Error("Clip lease lost");
}

export async function checkpointYoutubeClip(id: string, token: string, patch: {
  r2Key?: string; createStarted?: boolean; quality?: object;
  bytesProxy?: number; apifyUsd?: number; apifyRunId?: string | null;
}): Promise<void> {
  const result = await execute(`UPDATE youtube_clips SET
    bytes_proxy = bytes_proxy + ?, apify_usd = apify_usd + ?, apify_run_id = COALESCE(?, apify_run_id),
    r2_key = COALESCE(?, r2_key),
    create_started_at = CASE WHEN ? THEN unixepoch() ELSE create_started_at END,
    quality_json = COALESCE(?, quality_json)
    WHERE id = ? AND lease_token = ? AND status = 'running' AND lease_expires_at > unixepoch()`,
    [Math.max(0, patch.bytesProxy ?? 0), Math.max(0, patch.apifyUsd ?? 0), patch.apifyRunId ?? null,
      patch.r2Key ?? null, patch.createStarted ? 1 : 0, patch.quality ? JSON.stringify(patch.quality) : null, id, token]);
  if (!result.rowsAffected) throw new Error("Clip lease lost");
}

export async function finishYoutubeClip(input: {
  id: string;
  leaseToken: string;
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
         finished_at = ?, lease_token = NULL, lease_expires_at = NULL
     WHERE id = ? AND lease_token = ? AND status = 'running' AND lease_expires_at > unixepoch()`,
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
      input.leaseToken,
    ]
  );
}

/** Acceptance consumes the remaining attempt and never refetches the sample. */
export async function acceptYoutubeClipRisk(userId: string, id: string): Promise<YoutubeClipRow | null> {
  await ensureTtsJobColumns();
  const rows = await query<YoutubeClipRow>(`UPDATE youtube_clips
    SET accept_quality_risk = 1, status = 'queued', error_code = NULL,
      finished_at = NULL, phase = NULL, lease_token = NULL, lease_expires_at = NULL
    WHERE id = ? AND user_id = ? AND status = 'failed' AND error_code = 'risky_audio'
      AND create_started_at IS NULL AND attempts < 2 AND r2_key IS NOT NULL
      AND COALESCE(accept_quality_risk, 0) = 0
    RETURNING *`, [id, userId]);
  return rows[0] ?? null;
}
