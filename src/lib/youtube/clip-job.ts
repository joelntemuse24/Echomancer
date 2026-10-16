/**
 * One claimed clip: temp dir, section download, master, R2, Fish.
 * The directory is mode 0700 and removed in finally.
 */

import { chmod, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppError } from "@/lib/errors";
import { uploadFile, downloadFile } from "@/lib/storage";
import { getClonedVoiceForUser } from "@/lib/turso/cloned-voices";
import { getCloneUploadByIdForUser, insertPendingCloneUpload } from "@/lib/turso/clone-uploads";
import { cloneNameOrFallback } from "@/lib/clone-name";
import { canonicalYoutubeUrl } from "@/lib/youtube/range";
import { masterClipPcm } from "@/lib/youtube/clip-master";
import { downloadYoutubeSection } from "@/lib/youtube/clip-fetch";
import {
  clampClipLength,
  clipRetryable,
  type ClipErrorCode,
} from "@/lib/youtube/clip-policy";
import {
  claimYoutubeClip,
  heartbeatYoutubeClip,
  checkpointYoutubeClip,
  clipBudgetExceeded,
  finishYoutubeClip,
  setYoutubeClipPhase,
  type YoutubeClipRow,
} from "@/lib/youtube/clip-store";

let clipBusy = false;

/** One section at a time; overlapping drain requests are ignored. */
export async function drainProxyClip(): Promise<void> {
  if (clipBusy) return;
  clipBusy = true;
  try {
    const row = await claimYoutubeClip();
    if (!row) return;
    await runClaimedClip(row);
  } finally {
    clipBusy = false;
  }
}

async function decodeToPcm(file: string): Promise<Float32Array> {
  const bin = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
  const child = spawn(bin, ["-v", "error", "-i", file, "-t", "42", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const exited = new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", (status) => resolve(status));
  });
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of child.stdout!) chunks.push(Buffer.from(chunk));
  } finally {
    clearTimeout(timer);
  }
  const code = await exited;
  if (code !== 0) throw new Error("decode failed");
  const buf = Buffer.concat(chunks);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

/** A stored row can still say more than 40s. The fetch uses the cap. */
function clipBounds(row: YoutubeClipRow): { startSec: number; endSec: number } {
  const startSec = Math.max(0, Number(row.start_seconds) || 0);
  return { startSec, endSec: startSec + clampClipLength(Number(row.length_seconds)) };
}

async function cloneMasteredWav(row: YoutubeClipRow, _wav: Buffer, signal: AbortSignal, beforeCreate: () => Promise<void>): Promise<void> {
  const upload = await getCloneUploadByIdForUser(row.user_id, row.id);
  if (!upload) throw new Error("Prepared sample missing");
  const { completeStoredClone } = await import("@/lib/tts/complete-clone");
  const { checkCloneReference } = await import("@/lib/tts/reference-quality/check");
  await completeStoredClone({
    checkReference: checkCloneReference,
    userId: row.user_id,
    upload,
    signal,
    beforeCreate,
    acceptQualityRisk: Number(row.accept_quality_risk) === 1,
    title: cloneNameOrFallback(row.title),
    accent: "american",
    source: {
      kind: "youtube",
      url: canonicalYoutubeUrl(row.video_id),
      ...clipBounds(row),
      consentedAt: Number(row.consent_at),
    },
  });
}

export async function runClaimedClip(
  row: YoutubeClipRow,
  deps?: {
    token?: string;
    download?: typeof downloadYoutubeSection;
    decode?: (file: string) => Promise<Float32Array>;
    clone?: (row: YoutubeClipRow, wav: Buffer, signal: AbortSignal, beforeCreate: () => Promise<void>) => Promise<void>;
  }
): Promise<void> {
  if (!row.lease_token) throw new Error("Clip lease missing");
  const leaseToken = row.lease_token;
  const token = deps?.token ?? process.env.APIFY_TOKEN?.trim() ?? "";
  const dir = await mkdtemp(path.join(tmpdir(), "ytclip-"));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Clip operation timed out")), 10 * 60_000);
  let renewing = false;
  const heartbeat = setInterval(() => {
    if (renewing || controller.signal.aborted) return;
    renewing = true;
    void heartbeatYoutubeClip(row.id, leaseToken).then((held) => {
      if (!held) controller.abort(new Error("Clip lease lost"));
    }).catch(() => controller.abort(new Error("Clip heartbeat failed")))
      .finally(() => { renewing = false; });
  }, 20_000);
  let bytes = 0;
  let runId: string | null = null;
  let usd = 0;
  let createStarted = Boolean(row.create_started_at);
  const assertLease = async () => {
    controller.signal.throwIfAborted();
    if (!(await heartbeatYoutubeClip(row.id, leaseToken))) throw new Error("Clip lease lost");
  };
  const bounded = async <T>(operation: Promise<T>): Promise<T> => {
    controller.signal.throwIfAborted();
    let abort: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", abort, { once: true });
    });
    try { return await Promise.race([operation, cancelled]); }
    finally { controller.signal.removeEventListener("abort", abort); }
  };
  try {
    await chmod(dir, 0o700);
    await assertLease();
    if (await getClonedVoiceForUser(row.user_id, row.id)) {
      await finishYoutubeClip({ id: row.id, leaseToken, status: "ready", bytesProxy: 0 });
      return;
    }
    if (createStarted) {
      await settle(row, "provider_uncertain", 0, null, 0);
      return;
    }
    let wav: Buffer;
    if (row.r2_key) {
      wav = await bounded(downloadFile(row.r2_key));
    } else {
      if (!token || await clipBudgetExceeded(row.user_id)) {
        await settle(row, token ? "budget" : "unavailable", 0, null, 0);
        return;
      }
      const fetchedAt = Date.now();
      await setYoutubeClipPhase(row.id, "fetching", leaseToken);
      const bounds = clipBounds(row);
      const downloaded = await bounded((deps?.download ?? downloadYoutubeSection)({
        token,
        signal: controller.signal,
        videoId: row.video_id,
        startSec: bounds.startSec,
        endSec: bounds.endSec,
        cwd: dir,
        videoSeconds: row.video_seconds != null ? Number(row.video_seconds) : null,
        mayFallback: async (spentUsd) => {
          await assertLease();
          return !(await clipBudgetExceeded(row.user_id, Date.now(), spentUsd));
        },
      }));
      const downloadedAt = Date.now();
      bytes = downloaded.bytes;
      runId = downloaded.runId;
      usd = downloaded.usd;
      await checkpointYoutubeClip(row.id, leaseToken, { bytesProxy: bytes, apifyUsd: usd, apifyRunId: runId });
      bytes = 0;
      usd = 0;
      if (!downloaded.ok) {
        await settle(row, downloaded.code, bytes, runId, usd, downloaded.actorsTried);
        return;
      }

      await setYoutubeClipPhase(row.id, "preparing", leaseToken);
      const pcm = await bounded((deps?.decode ?? decodeToPcm)(downloaded.file));
      const decodedAt = Date.now();
      const mastered = masterClipPcm(pcm, 48_000, bounds.endSec - bounds.startSec);
      const masteredAt = Date.now();
      if (!mastered.ok) {
        await settle(row, mastered.code, bytes, runId, usd);
        return;
      }
      wav = mastered.wav;
      await assertLease();
      const stored = await bounded(uploadFile(`clips/${row.user_id}`, `${row.id}.wav`, wav, "audio/wav"));
      await checkpointYoutubeClip(row.id, leaseToken, { r2Key: stored.path });
      console.info(`[yt-clip] ${row.id} prepared actor=${downloaded.actor} fetch=${downloadedAt - fetchedAt} decode=${decodedAt - downloadedAt} master=${masteredAt - decodedAt}`);
    }
    await assertLease();
    const existingUpload = await getCloneUploadByIdForUser(row.user_id, row.id);
    if (!existingUpload) {
      await insertPendingCloneUpload({ id: row.id, userId: row.user_id,
        sampleStoragePath: row.r2_key ?? `clips/${row.user_id}/${row.id}.wav`,
        fileName: `${row.id}.wav`, contentType: "audio/wav", byteSize: wav.length });
    }
    await assertLease();
    if (!(await getClonedVoiceForUser(row.user_id, row.id))) {
      const beforeCreate = async () => {
        await assertLease();
        await checkpointYoutubeClip(row.id, leaseToken, { createStarted: true });
        createStarted = true;
      };
      await bounded((deps?.clone ?? cloneMasteredWav)(row, wav, controller.signal, beforeCreate));
    }
    await finishYoutubeClip({
      id: row.id,
      leaseToken,
      status: "ready",
      bytesProxy: bytes,
      r2Key: `clips/${row.user_id}/${row.id}.wav`,
      apifyRunId: runId,
      apifyUsd: usd,
    });
  } catch (err) {
    const text = err instanceof Error ? err.message : "error";
    console.info(`[yt-clip] ${row.id} failed ${token ? text.split(token).join("[token]") : text}`);
    const code: ClipErrorCode =
      err instanceof AppError && err.code === "SAMPLE_QUALITY"
        ? "unusable_audio"
        : err instanceof AppError && err.code === "SAMPLE_RISKY"
          ? "risky_audio"
          : createStarted ? "provider_uncertain" : "unavailable";
    if (err instanceof AppError && err.details) {
      await checkpointYoutubeClip(row.id, leaseToken, { quality: err.details }).catch(() => {});
    }
    await settle(row, code, bytes, runId, usd);
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timer);
    controller.abort();
    await rm(dir, { recursive: true, force: true });
  }
}

async function settle(
  row: YoutubeClipRow,
  code: ClipErrorCode,
  bytes: number,
  runId: string | null,
  usd: number,
  actorsTried = 2
): Promise<void> {
  // The fetch already tried the other actor. Queue the row again only when
  // that fallback never ran (a transient blip on the single attempt).
  const retry = actorsTried < 2 && clipRetryable(code, Number(row.attempts));
  await finishYoutubeClip({
    id: row.id,
    leaseToken: row.lease_token!,
    status: retry ? "queued" : "failed",
    errorCode: retry ? null : code,
    bytesProxy: bytes,
    apifyRunId: runId,
    apifyUsd: usd,
  });
}
