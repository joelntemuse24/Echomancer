/**
 * Worker-side YouTube clip: section download → master → the same Fish
 * clone path as an uploaded sample. Vercel only forwards the request.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { uploadFile } from "@/lib/storage";
import {
  isAnonymousUserId,
  isDurableUserId,
} from "@/lib/auth/session";
import {
  DEFAULT_CLONE_ACCENT,
  parseCloneAccent,
} from "@/lib/tts/clone-accent";
import { completeStoredClone, cloneMayBeShared } from "@/lib/tts/complete-clone";
import { catalogIdForClone, clonedVoiceToCatalog } from "@/lib/tts/fish-clone";
import { isFishConfigured } from "@/lib/tts/providers/fish";
import { listClonedVoicesForUser } from "@/lib/turso/cloned-voices";
import { insertPendingCloneUpload, markCloneUploadFailed } from "@/lib/turso/clone-uploads";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { AppError } from "@/lib/errors";
import type {
  YoutubeClipFailure,
  YoutubeClipRequest,
  YoutubeClipResult,
} from "@/lib/youtube/clip-types";
import { YOUTUBE_COPY } from "@/lib/youtube/messages";
import {
  canonicalYoutubeUrl,
  isYoutubeVideoId,
  validateClipRange,
} from "@/lib/youtube/range";
import {
  downloadYoutubeSection,
  YoutubeFetchError,
  type YoutubeFetchEnv,
} from "@/lib/youtube/fetch-audio";
import { masterYoutubeClip } from "@/lib/youtube/master-clip";

export type { YoutubeClipRequest, YoutubeClipResult };

const JOB_BUDGET_MS = 42_000;

let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export async function runYoutubeClipJob(
  request: YoutubeClipRequest,
  deps?: {
    download?: typeof downloadYoutubeSection;
    master?: typeof masterYoutubeClip;
    now?: () => number;
    env?: YoutubeFetchEnv;
  }
): Promise<YoutubeClipResult> {
  return enqueue(() => runYoutubeClipJobNow(request, deps));
}

async function runYoutubeClipJobNow(
  request: YoutubeClipRequest,
  deps?: {
    download?: typeof downloadYoutubeSection;
    master?: typeof masterYoutubeClip;
    now?: () => number;
    env?: YoutubeFetchEnv;
  }
): Promise<YoutubeClipResult> {
  const now = deps?.now ?? Date.now;
  const started = now();
  const fail = (
    status: number,
    code: string,
    message: string
  ): YoutubeClipFailure => ({
    ok: false,
    status,
    code,
    message,
    fallback: "upload",
  });

  if (!request.consent) {
    return fail(400, "CONSENT_REQUIRED", YOUTUBE_COPY.consentRequired);
  }
  if (!isYoutubeVideoId(request.videoId)) {
    return fail(400, "INVALID_VIDEO", "That link is not a YouTube video.");
  }
  if (
    !isAnonymousUserId(request.userId) &&
    !isDurableUserId(request.userId)
  ) {
    return fail(400, "INVALID_USER", YOUTUBE_COPY.unavailable);
  }
  const range = validateClipRange(request.startSec, request.endSec);
  if (!range.ok) return fail(400, "INVALID_RANGE", range.message);
  if (!isFishConfigured()) {
    return fail(503, "FISH_NOT_CONFIGURED", "Voice cloning isn't available right now.");
  }

  await ensureTtsJobColumns();
  const existing = await listClonedVoicesForUser(request.userId);
  if (existing.length >= 20) {
    return fail(
      400,
      "CLONE_LIMIT",
      "You already have 20 cloned voices. Delete one to add another."
    );
  }

  const download = deps?.download ?? downloadYoutubeSection;
  const master = deps?.master ?? masterYoutubeClip;
  const workDir = await mkdtemp(path.join(tmpdir(), "echo-yt-"));
  const deadlineAt = started + JOB_BUDGET_MS;
  let fetchMs = 0;
  let masterMs = 0;
  let cloneMs = 0;
  let strategy = "";

  try {
    const fetchStarted = now();
    let filePath: string;
    try {
      const fetched = await download({
        videoId: request.videoId,
        startSec: range.startSec,
        endSec: range.endSec,
        workDir,
        env: deps?.env,
        deadlineAt,
        now,
      });
      filePath = fetched.filePath;
      strategy = fetched.strategy;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[youtube-clip] fetch failed video=${request.videoId} ${detail}`);
      return fail(502, "YOUTUBE_CLIP_UNAVAILABLE", YOUTUBE_COPY.fetchFailed);
    }
    fetchMs = now() - fetchStarted;

    const masterStarted = now();
    const mastered = await master(filePath);
    masterMs = now() - masterStarted;
    if (!mastered.ok) {
      return fail(
        422,
        mastered.code === "music"
          ? "CLIP_MUSIC"
          : mastered.code === "overlap"
            ? "CLIP_OVERLAP"
            : mastered.code === "separate_failed"
              ? "CLIP_SEPARATE"
              : "CLIP_SHORT",
        mastered.message
      );
    }

    const uploadId = randomUUID();
    const stored = await uploadFile(
      `clones/${uploadId}`,
      "sample.wav",
      mastered.clip.wav,
      "audio/wav"
    );
    await insertPendingCloneUpload({
      id: uploadId,
      userId: request.userId,
      sampleStoragePath: stored.path,
      fileName: "sample.wav",
      contentType: "audio/wav",
      byteSize: stored.size,
    });

    const cloneStarted = now();
    const accent = parseCloneAccent(request.accent ?? DEFAULT_CLONE_ACCENT);
    const title = request.title?.trim().slice(0, 80) || "My voice";
    try {
      const row = await completeStoredClone({
        userId: request.userId,
        upload: {
          id: uploadId,
          user_id: request.userId,
          sample_storage_path: stored.path,
          file_name: "sample.wav",
          content_type: "audio/wav",
          byte_size: stored.size,
          status: "pending",
          error_message: null,
          cloned_voice_id: null,
          created_at: Math.floor(Date.now() / 1000),
        },
        title,
        accent,
        source: {
          kind: "youtube",
          url: canonicalYoutubeUrl(request.videoId),
          startSec: range.startSec,
          endSec: range.endSec,
          consentedAt: Math.floor(Date.now() / 1000),
        },
      });
      if (row.source_kind !== "youtube" || cloneMayBeShared(row.source_kind)) {
        return fail(500, "CLONE_FAILED", YOUTUBE_COPY.fetchFailed);
      }
      cloneMs = now() - cloneStarted;
      const catalog = clonedVoiceToCatalog(row);
      console.info(
        `[youtube-clip] cloned video=${request.videoId} strategy=${strategy} fetchMs=${fetchMs} masterMs=${masterMs} cloneMs=${cloneMs}`
      );
      return {
        ok: true,
        strategy,
        timings: { fetchMs, masterMs, cloneMs, totalMs: now() - started },
        clone: {
          ...catalog,
          catalogVoiceId: catalogIdForClone(row.id),
          state: row.state,
          createdAt: row.created_at,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "clone failed";
      await markCloneUploadFailed(uploadId, message).catch(() => {});
      console.warn(`[youtube-clip] clone failed video=${request.videoId} ${message}`);
      if (err instanceof AppError && err.code === "SAMPLE_QUALITY") {
        return fail(422, "SAMPLE_QUALITY", err.message);
      }
      return fail(502, "CLONE_FAILED", YOUTUBE_COPY.fetchFailed);
    }
  } catch (err) {
    if (err instanceof YoutubeFetchError) {
      return fail(502, "YOUTUBE_CLIP_UNAVAILABLE", YOUTUBE_COPY.fetchFailed);
    }
    console.warn(
      "[youtube-clip] job failed",
      err instanceof Error ? err.message : err
    );
    return fail(502, "YOUTUBE_CLIP_UNAVAILABLE", YOUTUBE_COPY.fetchFailed);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
