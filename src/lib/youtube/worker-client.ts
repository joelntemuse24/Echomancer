/**
 * Vercel → always-on worker. Audio bytes stay on the VM.
 * This module must not import yt-dlp, ffmpeg, or the mastering worker.
 */

import { takehomeWorkerSecret, takehomeWorkerUrl } from "@/lib/jobs/takehome-worker-client";
import type { YoutubeClipRequest, YoutubeClipResult } from "@/lib/youtube/clip-types";
import { YOUTUBE_COPY } from "@/lib/youtube/messages";

const DEFAULT_TIMEOUT_MS = 50_000;

export function isYoutubeWorkerConfigured(): boolean {
  return Boolean(takehomeWorkerUrl() && takehomeWorkerSecret());
}

export async function requestYoutubeClipOnWorker(
  request: YoutubeClipRequest
): Promise<YoutubeClipResult> {
  const url = takehomeWorkerUrl();
  const secret = takehomeWorkerSecret();
  if (!url || !secret) {
    return {
      ok: false,
      status: 503,
      code: "YOUTUBE_NOT_CONFIGURED",
      message: YOUTUBE_COPY.unavailable,
      fallback: "upload",
    };
  }

  const timeoutMs = Number(process.env.YOUTUBE_CLIP_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(`${url}/youtube/clip`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(
        Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS
      ),
    });
    const payload = (await response.json().catch(() => null)) as YoutubeClipResult | null;
    if (payload && typeof payload === "object" && "ok" in payload) {
      if (!payload.ok) {
        return {
          ok: false,
          status: response.status || payload.status || 502,
          code: payload.code || "YOUTUBE_CLIP_UNAVAILABLE",
          message: payload.message || YOUTUBE_COPY.fetchFailed,
          fallback: "upload",
        };
      }
      return payload;
    }
    return {
      ok: false,
      status: 502,
      code: "YOUTUBE_CLIP_UNAVAILABLE",
      message: YOUTUBE_COPY.fetchFailed,
      fallback: "upload",
    };
  } catch (err) {
    console.warn(
      "[youtube-clip] worker request failed",
      err instanceof Error ? err.message : err
    );
    return {
      ok: false,
      status: 502,
      code: "YOUTUBE_CLIP_UNAVAILABLE",
      message: YOUTUBE_COPY.fetchFailed,
      fallback: "upload",
    };
  }
}
