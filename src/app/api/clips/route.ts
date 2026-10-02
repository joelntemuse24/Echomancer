/**
 * Queue a proxied YouTube section. The download runs on the worker.
 * Anyone else gets 404. Over a daily cap, 429, and the page uses upload.
 */

import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AppError, handleApiError } from "@/lib/errors";
import { requireSession } from "@/lib/auth/guard";
import { isDurableUserId } from "@/lib/auth/session";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { takehomeWorkerSecret, takehomeWorkerUrl } from "@/lib/jobs/takehome-worker-client";
import { proxyClipsEnabled } from "@/lib/youtube/clip-access";
import { clampClipLength } from "@/lib/youtube/clip-policy";
import { clipBudgetExceeded, insertYoutubeClip } from "@/lib/youtube/clip-store";
import { ClipVideoReject, inspectClipVideo } from "@/lib/youtube/clip-video";
import { isYoutubeVideoId } from "@/lib/youtube/range";

export const runtime = "nodejs";
export const maxDuration = 20;

const bodySchema = z.object({
  videoId: z.string().trim(),
  startSeconds: z.number().finite().min(0),
  lengthSeconds: z.number().finite().optional(),
  consent: z.literal(true),
});

export async function GET(request: NextRequest) {
  try {
    await ensureTtsJobColumns();
    const session = await requireSession(request);
    if (!isDurableUserId(session.userId)) {
      return NextResponse.json({ enabled: false });
    }
    const enabled = await proxyClipsEnabled(session.userId);
    return NextResponse.json({ enabled });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    await ensureTtsJobColumns();
    const session = await requireSession(request);
    if (!isDurableUserId(session.userId) || !(await proxyClipsEnabled(session.userId))) {
      throw new AppError("NOT_FOUND", "Not found", 404);
    }
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success || !isYoutubeVideoId(parsed.data.videoId)) {
      throw new AppError("INVALID_BODY", "That clip could not be started.", 400);
    }
    if (await clipBudgetExceeded(session.userId)) {
      return NextResponse.json(
        { error: "Today's download limit is used. Upload a file instead.", code: "budget" },
        { status: 429 }
      );
    }

    const lengthSeconds = clampClipLength(parsed.data.lengthSeconds);
    const startSeconds = parsed.data.startSeconds;
    let videoSeconds: number | null = null;
    try {
      const facts = await inspectClipVideo(parsed.data.videoId, startSeconds, lengthSeconds);
      videoSeconds = facts.durationSec;
    } catch (err) {
      if (err instanceof ClipVideoReject) {
        throw new AppError(err.code, err.code, 400);
      }
      throw err;
    }

    const id = randomUUID();
    await insertYoutubeClip({
      id,
      userId: session.userId,
      videoId: parsed.data.videoId,
      startSeconds,
      lengthSeconds,
      consentAt: Date.now(),
      videoSeconds,
    });
    void wakeClipWorker();
    return NextResponse.json({ id, status: "queued" });
  } catch (error) {
    return handleApiError(error);
  }
}

async function wakeClipWorker(): Promise<void> {
  const base = takehomeWorkerUrl();
  const secret = takehomeWorkerSecret();
  if (!base || !secret) return;
  await fetch(`${base}/clips/wake`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(3_000),
  }).catch(() => {});
}
