/**
 * POST /api/tts/clones/upload — mint a short-lived storage PUT for a sample.
 *
 * Tiny JSON only: { fileName, contentType, byteSize }. The browser PUTs the
 * audio to R2 (or a local object route in development). Fish clone create
 * runs after complete — never over this function body.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";
import { AppError, handleApiError } from "@/lib/errors";
import { requireSession } from "@/lib/auth/guard";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { isFishConfigured } from "@/lib/tts/providers/fish";
import { listClonedVoicesForUser } from "@/lib/turso/cloned-voices";
import { insertPendingCloneUpload } from "@/lib/turso/clone-uploads";
import { clientIp, rateLimitIdentity } from "@/lib/rate-limit";
import { uploadRateLimit } from "@/lib/uploads/rate-limit";
import {
  rejectMultipartUpload,
  rejectOversizedFunctionBody,
} from "@/lib/uploads/http";
import { isProductionDispatch } from "@/lib/jobs/trigger-takehome";
import {
  PRESIGN_EXPIRES_SECONDS,
  getUploadUrl,
  isR2Configured,
} from "@/lib/r2-storage";
import {
  contentTypeForCloneSample,
  maxCloneSampleBytes,
  maxCloneSampleMb,
  MIN_CLONE_SAMPLE_BYTES,
  safeCloneSampleExtension,
} from "@/lib/clone-sample-formats";

export const runtime = "nodejs";
export const maxDuration = 30;

const CLONE_PRESIGN_MULTIPART =
  "Do not POST the audio sample through this server. Request a storage URL with JSON { fileName, contentType, byteSize }, PUT the file there, then create the clone with { uploadId }.";

const presignSchema = z.object({
  fileName: z.string().trim().min(1).max(240),
  contentType: z.string().trim().max(200).optional(),
  byteSize: z.number().int().positive(),
});

export async function POST(request: NextRequest) {
  try {
    await ensureTtsJobColumns();
    rejectMultipartUpload(request, CLONE_PRESIGN_MULTIPART);
    rejectOversizedFunctionBody(request);

    const session = await requireSession(request);

    if (!isFishConfigured()) {
      throw new AppError(
        "FISH_NOT_CONFIGURED",
        "Voice cloning isn't available right now.",
        503
      );
    }

    if (
      !(await uploadRateLimit(
        await rateLimitIdentity({
          userId: session.userId,
          ip: clientIp(request),
        })
      ))
    ) {
      return NextResponse.json(
        { error: "Too many uploads. Please wait a minute and try again." },
        { status: 429 }
      );
    }

    const raw = await request.json().catch(() => null);
    const parsed = presignSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(
        "INVALID_BODY",
        "Send JSON { fileName, contentType, byteSize } — not the file itself.",
        400
      );
    }

    const { fileName, byteSize } = parsed.data;
    const contentType = contentTypeForCloneSample(
      fileName,
      parsed.data.contentType
    );
    if (!contentType) {
      throw new AppError(
        "INVALID_SAMPLE",
        "Use wav, mp3, m4a, opus, ogg, or webm samples.",
        400
      );
    }

    if (byteSize < MIN_CLONE_SAMPLE_BYTES) {
      throw new AppError(
        "INVALID_SAMPLE",
        "That sample is too short. Use at least ~10 seconds of clear speech.",
        400
      );
    }
    if (byteSize > maxCloneSampleBytes()) {
      throw new AppError(
        "FILE_TOO_LARGE",
        `Sample must be ${maxCloneSampleMb()} MB or smaller.`,
        413
      );
    }

    const existing = await listClonedVoicesForUser(session.userId);
    if (existing.length >= 20) {
      throw new AppError(
        "CLONE_LIMIT",
        "You already have 20 cloned voices. Delete one to add another.",
        400
      );
    }

    if (isProductionDispatch() && !isR2Configured()) {
      throw new AppError(
        "STORAGE_NOT_CONFIGURED",
        "Object storage is not configured, so voice-clone uploads are disabled.",
        503
      );
    }

    const uploadId = randomUUID();
    const ext = safeCloneSampleExtension(fileName, contentType);
    const sampleStoragePath = `clones/${uploadId}/sample.${ext}`;

    await insertPendingCloneUpload({
      id: uploadId,
      userId: session.userId,
      sampleStoragePath,
      fileName,
      contentType,
      byteSize,
    });

    const putHeaders: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Length": String(byteSize),
    };

    const putUrl = isR2Configured()
      ? await getUploadUrl(sampleStoragePath, {
          contentType,
          contentLength: byteSize,
        })
      : `/api/tts/clones/upload/${uploadId}/object`;

    return NextResponse.json({
      uploadId,
      putUrl,
      putMethod: "PUT",
      putHeaders,
      sampleStoragePath,
      expiresIn: PRESIGN_EXPIRES_SECONDS,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
