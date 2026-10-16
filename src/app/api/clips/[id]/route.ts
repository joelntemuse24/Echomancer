/**
 * Status for one proxied clip. A finished row includes a 10-minute signed URL.
 */

import { createHmac } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { AppError, handleApiError } from "@/lib/errors";
import { requireSession } from "@/lib/auth/guard";
import { isDurableUserId } from "@/lib/auth/session";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { signedDownloadUrl } from "@/lib/storage";
import { catalogIdForClone } from "@/lib/tts/fish-clone";
import { queryOne } from "@/lib/turso";
import { getCloneUploadByIdForUser } from "@/lib/turso/clone-uploads";
import { takehomeWorkerSecret, takehomeWorkerUrl } from "@/lib/jobs/takehome-worker-client";
import { acceptYoutubeClipRisk, getYoutubeClipForUser } from "@/lib/youtube/clip-store";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await ensureTtsJobColumns();
    const session = await requireSession(request);
    const { id } = await context.params;
    if (!isDurableUserId(session.userId)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const row = await getYoutubeClipForUser(session.userId, id);
    if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const upload = await getCloneUploadByIdForUser(session.userId, id);
    const samplePath = row.r2_key ?? upload?.sample_storage_path;
    const downloadUrl = samplePath ? await signedDownloadUrl(samplePath).catch(() => null) : null;
    let quality: unknown = null;
    try { quality = row.quality_json ? JSON.parse(row.quality_json) : null; } catch {}
    const risk = quality && typeof quality === "object" && "quality" in quality ? quality.quality : quality;

    const voice = await queryOne<{ id: string }>(
      `SELECT id FROM cloned_voices WHERE id = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1`,
      [id, session.userId]
    );
    return NextResponse.json({
      id: row.id,
      ownerContext: createHmac("sha256", process.env.SESSION_SECRET || process.env.INTERNAL_JOB_SECRET || "")
        .update(`clip-owner:${session.userId}`).digest("hex"),
      title: row.title,
      source: { videoId: row.video_id, startSec: row.start_seconds, endSec: row.start_seconds + row.length_seconds },
      status: row.status,
      error: row.error_code,
      phase: row.phase,
      downloadUrl,
      preparedSampleUrl: downloadUrl,
      uploadId: upload?.id ?? null,
      quality: risk,
      risk,
      requiresReview: row.error_code === "provider_uncertain",
      catalogVoiceId: voice ? catalogIdForClone(voice.id) : null,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(request);
    const { id } = await context.params;
    const row = await getYoutubeClipForUser(session.userId, id);
    if (!isDurableUserId(session.userId) || !row) throw new AppError("NOT_FOUND", "Not found", 404);
    const body = await request.json().catch(() => null);
    if (body?.acceptQualityRisk !== true) throw new AppError("INVALID_BODY", "Accept the sample quality warning to continue.", 400);
    const accepted = await acceptYoutubeClipRisk(session.userId, id);
    if (!accepted) throw new AppError("CLIP_NOT_RETRYABLE", "This clip cannot be retried. Check its current status.", 409);
    const base = takehomeWorkerUrl();
    const secret = takehomeWorkerSecret();
    if (base && secret) void fetch(`${base}/clips/wake`, {
      method: "POST", headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(3_000),
    }).catch(() => {});
    return NextResponse.json({ id: accepted.id, status: accepted.status }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return handleApiError(error); }
}
