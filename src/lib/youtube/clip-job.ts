/**
 * One claimed clip: temp dir, section download, master, R2, Fish.
 * The directory is mode 0700 and removed in finally.
 */

import { chmod, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppError } from "@/lib/errors";
import { uploadFile } from "@/lib/storage";
import { insertPendingCloneUpload } from "@/lib/turso/clone-uploads";
import { canonicalYoutubeUrl } from "@/lib/youtube/range";
import { masterClipPcm } from "@/lib/youtube/clip-master";
import { downloadYoutubeSection } from "@/lib/youtube/clip-fetch";
import {
  clipRetryable,
  type ClipErrorCode,
} from "@/lib/youtube/clip-policy";
import {
  claimYoutubeClip,
  clipBudgetExceeded,
  finishYoutubeClip,
  type YoutubeClipRow,
} from "@/lib/youtube/clip-store";

let clipBusy = false;

/** One section at a time. A second call waits until the first returns. */
export async function drainProxyClip(): Promise<void> {
  if (clipBusy || !process.env.APIFY_TOKEN?.trim()) return;
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
  const child = spawn(bin, ["-v", "error", "-i", file, "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const chunks: Buffer[] = [];
  for await (const chunk of child.stdout!) chunks.push(Buffer.from(chunk));
  const code = await new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("exit", (status) => resolve(status));
  });
  if (code !== 0) throw new Error("decode failed");
  const buf = Buffer.concat(chunks);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

async function cloneMasteredWav(row: YoutubeClipRow, wav: Buffer): Promise<void> {
  const stored = await uploadFile(`clips/${row.user_id}`, `${row.id}.wav`, wav, "audio/wav");
  await insertPendingCloneUpload({
    id: row.id,
    userId: row.user_id,
    sampleStoragePath: stored.path,
    fileName: `${row.id}.wav`,
    contentType: "audio/wav",
    byteSize: stored.size,
  });
  const { completeStoredClone } = await import("@/lib/tts/complete-clone");
  await completeStoredClone({
    userId: row.user_id,
    upload: {
      id: row.id,
      user_id: row.user_id,
      sample_storage_path: stored.path,
      file_name: `${row.id}.wav`,
      content_type: "audio/wav",
      byte_size: stored.size,
      status: "pending",
      error_message: null,
      cloned_voice_id: null,
      created_at: row.created_at,
    },
    title: "YouTube clip",
    accent: "american",
    source: {
      kind: "youtube",
      url: canonicalYoutubeUrl(row.video_id),
      startSec: Number(row.start_seconds),
      endSec: Number(row.start_seconds) + Number(row.length_seconds),
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
    clone?: (row: YoutubeClipRow, wav: Buffer) => Promise<void>;
  }
): Promise<void> {
  const token = deps?.token ?? process.env.APIFY_TOKEN?.trim() ?? "";
  const dir = await mkdtemp(path.join(tmpdir(), "ytclip-"));
  await chmod(dir, 0o700);
  let bytes = 0;
  let runId: string | null = null;
  let usd = 0;
  try {
    if (!token) {
      await finishYoutubeClip({
        id: row.id,
        status: "failed",
        errorCode: "unavailable",
        bytesProxy: 0,
      });
      return;
    }
    if (await clipBudgetExceeded(row.user_id)) {
      await finishYoutubeClip({
        id: row.id,
        status: "failed",
        errorCode: "budget",
        bytesProxy: 0,
      });
      return;
    }

    const downloaded = await (deps?.download ?? downloadYoutubeSection)({
      token,
      videoId: row.video_id,
      startSec: Number(row.start_seconds),
      endSec: Number(row.start_seconds) + Number(row.length_seconds),
      cwd: dir,
    });
    bytes = downloaded.bytes;
    runId = downloaded.runId;
    usd = downloaded.usd;
    if (!downloaded.ok) {
      await settle(row, downloaded.code, bytes, runId, usd);
      return;
    }

    const pcm = await (deps?.decode ?? decodeToPcm)(downloaded.file);
    const mastered = masterClipPcm(pcm);
    if (!mastered.ok) {
      await settle(row, mastered.code, bytes, runId, usd);
      return;
    }
    await (deps?.clone ?? cloneMasteredWav)(row, mastered.wav);
    await finishYoutubeClip({
      id: row.id,
      status: "ready",
      bytesProxy: bytes,
      r2Key: `clips/${row.user_id}/${row.id}.wav`,
      apifyRunId: runId,
      apifyUsd: usd,
    });
  } catch (err) {
    const text = err instanceof Error ? err.message : "error";
    console.info(`[yt-clip] ${row.id} failed ${token ? text.split(token).join("[token]") : text}`);
    const code =
      err instanceof AppError && err.code === "SAMPLE_QUALITY" ? "unusable_audio" : "unavailable";
    await settle(row, code, bytes, runId, usd);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function settle(
  row: YoutubeClipRow,
  code: ClipErrorCode,
  bytes: number,
  runId: string | null,
  usd: number
): Promise<void> {
  const retry = clipRetryable(code, Number(row.attempts));
  await finishYoutubeClip({
    id: row.id,
    status: retry ? "queued" : "failed",
    errorCode: retry ? null : code,
    bytesProxy: bytes,
    apifyRunId: runId,
    apifyUsd: usd,
  });
}
