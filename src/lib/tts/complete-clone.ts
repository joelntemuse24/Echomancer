/**
 * Finish a clone from a sample already in storage.
 * File uploads and YouTube clips both land here, then Fish `POST /model`.
 * YouTube rows store the source URL, range, and consent time. Fish
 * visibility stays private — the same call file uploads use.
 */

import { AppError } from "@/lib/errors";
import { downloadFile, getFileMetadata } from "@/lib/storage";
import {
  MIN_CLONE_SAMPLE_BYTES,
  maxCloneSampleBytes,
  maxCloneSampleMb,
} from "@/lib/clone-sample-formats";
import { cleanupCloneSample } from "@/lib/tts/clone-sample-audio";
import { analyzeCloneSampleBuffer } from "@/lib/tts/clone-sample-quality-analyze";
import { requestReferenceCheck, type WorkerReferenceCheck } from "@/lib/tts/reference-quality/client";
import type { CloneAccent } from "@/lib/tts/clone-accent";
import type { ClonedVoiceRow } from "@/lib/tts/fish-clone";
import {
  createFishVoiceClone,
  FISH_NATIVE_FREE_MODEL,
} from "@/lib/tts/providers/fish";
import { transcribeCloneReference } from "@/lib/tts/transcript-qa";
import { markCloneUploadCompleted, markCloneUploadFailed, type CloneUploadRow } from "@/lib/turso/clone-uploads";
import { insertClonedVoice } from "@/lib/turso/cloned-voices";

export type YoutubeCloneSource = {
  kind: "youtube";
  url: string;
  startSec: number;
  endSec: number;
  consentedAt: number;
};

export async function completeStoredClone(opts: {
  userId: string;
  upload: CloneUploadRow;
  title: string;
  transcript?: string;
  accent: CloneAccent;
  source?: YoutubeCloneSource | null;
  /** The user saw the "may not clone well" warning and chose to continue. */
  acceptQualityRisk?: boolean;
  /** On the worker the check runs in-process instead of over HTTP. */
  checkReference?: (input: {
    uploadId: string;
    samplePath: string;
    remasterFailing?: boolean;
  }) => Promise<WorkerReferenceCheck | null>;
  signal?: AbortSignal;
}): Promise<ClonedVoiceRow> {
  const uploadId = opts.upload.id;
  const samplePath = opts.upload.sample_storage_path;
  const meta = await getFileMetadata(samplePath);
  if (!meta || meta.size <= 0) {
    throw new AppError(
      "FILE_MISSING",
      "Still uploading. Try again in a moment.",
      400
    );
  }

  const declared = Number(opts.upload.byte_size || 0);
  if (
    meta.size > maxCloneSampleBytes() ||
    (declared > 0 && meta.size > declared)
  ) {
    throw new AppError(
      "FILE_TOO_LARGE",
      `Sample must be ${maxCloneSampleMb()} MB or smaller.`,
      413
    );
  }

  const buf = await downloadFile(samplePath);
  if (buf.byteLength < MIN_CLONE_SAMPLE_BYTES) {
    throw new AppError(
      "INVALID_SAMPLE",
      "That sample is too short. Use at least ~10 seconds of clear speech.",
      400
    );
  }

  const sourceName = samplePath.split("/").pop() || "sample.bin";
  const contentType = opts.upload.content_type || "application/octet-stream";
  const quality = analyzeCloneSampleBuffer(buf);
  if (quality?.verdict === "fail") {
    await markCloneUploadFailed(uploadId, quality.headline).catch(() => {});
    throw new AppError("SAMPLE_QUALITY", quality.headline, 422, {
      ...quality,
    });
  }

  // Scored on the worker (DNSMOS, phone band, speakers, pitch spread).
  // Null when the worker is unavailable: cloning goes ahead as before.
  const reference = await (opts.checkReference ?? requestReferenceCheck)({
    uploadId,
    samplePath,
    remasterFailing: opts.acceptQualityRisk === true,
  }).catch(() => null);
  if (reference) {
    console.log(
      `[reference-quality] clone upload=${uploadId} user=${opts.userId} verdict=${reference.report.verdict} ` +
        `issues=${reference.report.issues.map((i) => i.code).join(",") || "-"} ` +
        `remastered=${Boolean(reference.remasteredPath)} accepted=${Boolean(opts.acceptQualityRisk)} ms=${reference.ms}`
    );
  }
  if (reference?.report.verdict === "fail" && !opts.acceptQualityRisk) {
    throw new AppError("SAMPLE_RISKY", reference.report.headline, 409, {
      quality: reference.report,
      uploadId,
    });
  }
  let cloneBuf = buf;
  let cloneName = sourceName;
  let cloneType = contentType;
  if (reference?.remasteredPath) {
    const cleaned = await downloadFile(reference.remasteredPath).catch(() => null);
    if (cleaned && cleaned.byteLength >= MIN_CLONE_SAMPLE_BYTES) {
      cloneBuf = cleaned;
      cloneName = "sample-remastered.wav";
      cloneType = "audio/wav";
    }
  }

  const wantTranscript = opts.source?.kind === "youtube" && !opts.transcript?.trim();
  const heard = wantTranscript ? transcribeCloneReference(buf, contentType) : null;
  const prepared = cleanupCloneSample(cloneBuf, cloneName, cloneType);
  const transcript =
    opts.transcript?.trim() || (heard ? (await heard).text || undefined : undefined);

  try {
    const fish = await createFishVoiceClone({
      title: opts.title.slice(0, 80),
      audio: prepared.audio,
      filename: prepared.filename,
      contentType: prepared.contentType,
      transcript,
      description: "Echomancer cloned narrator",
      signal: opts.signal,
    });

    const source = opts.source?.kind === "youtube" ? opts.source : null;
    const row = await insertClonedVoice({
      id: uploadId,
      userId: opts.userId,
      fishVoiceId: fish.fishVoiceId,
      title: fish.title.slice(0, 80),
      sampleStoragePath: samplePath,
      state: fish.state,
      model: FISH_NATIVE_FREE_MODEL,
      accent: opts.accent,
      sourceKind: source?.kind ?? null,
      sourceUrl: source?.url ?? null,
      sourceStartSec: source?.startSec ?? null,
      sourceEndSec: source?.endSec ?? null,
      sourceConsentedAt: source?.consentedAt ?? null,
    });
    await markCloneUploadCompleted(uploadId, row.id);
    return row;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Couldn't clone that voice.";
    await markCloneUploadFailed(uploadId, message).catch(() => {});
    throw error;
  }
}
