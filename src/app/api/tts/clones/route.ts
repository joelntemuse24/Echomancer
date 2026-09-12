import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError, AppError } from "@/lib/errors";
import { requireSession } from "@/lib/auth/guard";
import {
  clientIp,
  createRateLimiter,
  rateLimitIdentity,
} from "@/lib/rate-limit";
import {
  createFishVoiceClone,
  FISH_NATIVE_FREE_MODEL,
  isFishConfigured,
} from "@/lib/tts/providers/fish";
import {
  getClonedVoiceForUser,
  insertClonedVoice,
  listClonedVoicesForUser,
} from "@/lib/turso/cloned-voices";
import {
  cloneUploadStatus,
  getCloneUploadByIdForUser,
  markCloneUploadCompleted,
  markCloneUploadFailed,
} from "@/lib/turso/clone-uploads";
import {
  catalogIdForClone,
  clonedVoiceToCatalog,
} from "@/lib/tts/fish-clone";
import { downloadFile, getFileMetadata } from "@/lib/storage";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { cleanupCloneSample } from "@/lib/tts/clone-sample-audio";
import { analyzeCloneSampleBuffer } from "@/lib/tts/clone-sample-quality-analyze";
import {
  rejectMultipartUpload,
  rejectOversizedFunctionBody,
} from "@/lib/uploads/http";
import {
  MIN_CLONE_SAMPLE_BYTES,
  maxCloneSampleBytes,
  maxCloneSampleMb,
} from "@/lib/clone-sample-formats";

export const runtime = "nodejs";
export const maxDuration = 60;

const cloneRateLimit = createRateLimiter(5, 60 * 60_000, { onError: "closed" });

const CLONE_CREATE_MULTIPART =
  "Do not POST the audio sample through this server. Request a storage URL with JSON { fileName, contentType, byteSize }, PUT the file there, then create the clone with { uploadId }.";

const createSchema = z.object({
  uploadId: z.string().trim().min(1).max(80),
  title: z.string().trim().max(80).optional(),
  transcript: z.string().trim().max(4000).optional(),
});

export async function GET(request: NextRequest) {
  try {
    await ensureTtsJobColumns();
    const session = await requireSession(request);
    if (!isFishConfigured()) {
      return NextResponse.json({
        clones: [],
        configured: false,
        error: "Voice cloning isn't available right now.",
      });
    }
    const rows = await listClonedVoicesForUser(session.userId);
    return NextResponse.json({
      configured: true,
      clones: rows.map((r) => ({
        ...clonedVoiceToCatalog(r),
        catalogVoiceId: catalogIdForClone(r.id),
        state: r.state,
        createdAt: r.created_at,
      })),
      count: rows.length,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

function cloneResponse(
  row: Awaited<ReturnType<typeof insertClonedVoice>>
) {
  const catalog = clonedVoiceToCatalog(row);
  return {
    clone: {
      ...catalog,
      catalogVoiceId: catalog.id,
      state: row.state,
      createdAt: row.created_at,
    },
  };
}

export async function POST(request: NextRequest) {
  try {
    await ensureTtsJobColumns();
    rejectMultipartUpload(request, CLONE_CREATE_MULTIPART);
    rejectOversizedFunctionBody(request);

    const session = await requireSession(request);

    if (!isFishConfigured()) {
      throw new AppError(
        "FISH_NOT_CONFIGURED",
        "Voice cloning isn't available right now.",
        503
      );
    }

    const identity = await rateLimitIdentity({
      userId: session.userId,
      ip: clientIp(request),
    });
    if (!(await cloneRateLimit(identity))) {
      return NextResponse.json(
        { error: "Too many clone attempts. Try again later." },
        { status: 429 }
      );
    }

    const raw = await request.json().catch(() => null);
    const parsed = createSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(
        "INVALID_BODY",
        "Send JSON { uploadId, title? } after PUTting the sample to storage.",
        400
      );
    }

    const { uploadId } = parsed.data;
    const title = parsed.data.title?.trim() || "My voice";
    const transcript = parsed.data.transcript?.trim() || undefined;

    const upload = await getCloneUploadByIdForUser(session.userId, uploadId);
    if (!upload) {
      throw new AppError("NOT_FOUND", "Cloned voice not found", 404);
    }

    const already = await getClonedVoiceForUser(session.userId, uploadId);
    if (already) {
      if (cloneUploadStatus(upload) !== "completed") {
        await markCloneUploadCompleted(uploadId, already.id);
      }
      return NextResponse.json(cloneResponse(already));
    }

    const status = cloneUploadStatus(upload);
    if (status === "completed" && upload.cloned_voice_id) {
      const existing = await getClonedVoiceForUser(
        session.userId,
        upload.cloned_voice_id
      );
      if (existing) return NextResponse.json(cloneResponse(existing));
    }

    const existing = await listClonedVoicesForUser(session.userId);
    if (existing.length >= 20) {
      throw new AppError(
        "CLONE_LIMIT",
        "You already have 20 cloned voices. Delete one to add another.",
        400
      );
    }

    const samplePath = upload.sample_storage_path;
    const meta = await getFileMetadata(samplePath);
    if (!meta || meta.size <= 0) {
      throw new AppError(
        "FILE_MISSING",
        "The sample has not finished uploading yet.",
        400
      );
    }

    const declared = Number(upload.byte_size || 0);
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
    const quality = analyzeCloneSampleBuffer(buf);
    if (quality?.verdict === "fail") {
      await markCloneUploadFailed(uploadId, quality.headline).catch(() => {});
      throw new AppError("SAMPLE_QUALITY", quality.headline, 422, {
        ...quality,
      });
    }

    const prepared = cleanupCloneSample(
      buf,
      sourceName,
      upload.content_type || undefined
    );

    try {
      const fish = await createFishVoiceClone({
        title: title.slice(0, 80),
        audio: prepared.audio,
        filename: prepared.filename,
        contentType: prepared.contentType,
        transcript,
        description: "Echomancer cloned narrator",
      });

      const row = await insertClonedVoice({
        id: uploadId,
        userId: session.userId,
        fishVoiceId: fish.fishVoiceId,
        title: fish.title.slice(0, 80),
        sampleStoragePath: samplePath,
        state: fish.state,
        model: FISH_NATIVE_FREE_MODEL,
      });
      await markCloneUploadCompleted(uploadId, row.id);
      return NextResponse.json(cloneResponse(row));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Couldn't clone that voice.";
      await markCloneUploadFailed(uploadId, message).catch(() => {});
      throw error;
    }
  } catch (error) {
    return handleApiError(error);
  }
}
