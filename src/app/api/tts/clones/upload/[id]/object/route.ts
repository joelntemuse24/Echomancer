/**
 * Local-only byte sink for clone samples (R2 credentials absent).
 * Production always presigns R2; this route 404s when R2 is configured so
 * sample bytes cannot be smuggled through a Vercel function.
 */

import { NextRequest, NextResponse } from "next/server";
import { AppError, handleApiError } from "@/lib/errors";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { requireSession } from "@/lib/auth/guard";
import {
  getCloneUploadByIdForUser,
  markCloneUploadUploaded,
} from "@/lib/turso/clone-uploads";
import { uploadFile } from "@/lib/storage";
import { isR2Configured } from "@/lib/r2-storage";
import { clientIp, rateLimitIdentity } from "@/lib/rate-limit";
import { uploadRateLimit } from "@/lib/uploads/rate-limit";
import {
  maxCloneSampleBytes,
  maxCloneSampleMb,
} from "@/lib/clone-sample-formats";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await ensureTtsJobColumns();

    if (isR2Configured()) {
      throw new AppError("NOT_FOUND", "Not found", 404);
    }

    const { id } = await context.params;
    const session = await requireSession(request);

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

    const row = await getCloneUploadByIdForUser(session.userId, id);
    if (!row) {
      throw new AppError("NOT_FOUND", "Cloned voice not found", 404);
    }

    const declaredLength = Number(request.headers.get("content-length") || "0");
    const allowed = Number(row.byte_size || 0);
    if (
      declaredLength > maxCloneSampleBytes() ||
      (allowed > 0 && declaredLength > allowed)
    ) {
      throw new AppError(
        "FILE_TOO_LARGE",
        `Sample must be ${maxCloneSampleMb()} MB or smaller.`,
        413
      );
    }

    const buffer = Buffer.from(await request.arrayBuffer());
    if (buffer.length === 0) {
      throw new AppError("EMPTY_FILE", "File is empty", 400);
    }
    if (
      buffer.length > maxCloneSampleBytes() ||
      (allowed > 0 && buffer.length > allowed)
    ) {
      throw new AppError(
        "FILE_TOO_LARGE",
        `Sample must be ${maxCloneSampleMb()} MB or smaller.`,
        413
      );
    }

    const sourceName = row.sample_storage_path.split("/").pop() || "sample.bin";
    await uploadFile(
      `clones/${id}`,
      sourceName,
      buffer,
      row.content_type || "application/octet-stream"
    );
    await markCloneUploadUploaded(id);

    return NextResponse.json({ ok: true, bytes: buffer.length });
  } catch (error) {
    return handleApiError(error);
  }
}
