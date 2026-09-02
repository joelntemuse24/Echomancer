/**
 * Local-only byte sink for development and tests (R2 credentials absent).
 * Production always presigns R2; this route 404s when R2 is configured so
 * file bytes cannot be smuggled through a Vercel function.
 */

import { NextRequest, NextResponse } from "next/server";
import { AppError, handleApiError } from "@/lib/errors";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { SessionSecretMissingError } from "@/lib/auth/session";
import { requireSession } from "@/lib/auth/guard";
import {
  getUploadByIdForUser,
  markUploadUploaded,
} from "@/lib/turso/uploads";
import { uploadFile } from "@/lib/storage";
import { isR2Configured } from "@/lib/r2-storage";
import { maxUploadBytes, maxUploadMb } from "@/lib/document-formats";
import { clientIp, rateLimitIdentity } from "@/lib/rate-limit";
import { uploadRateLimit } from "@/lib/uploads/rate-limit";

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

    const row = await getUploadByIdForUser(session.userId, id);
    if (!row || !row.source_path) {
      throw new AppError("NOT_FOUND", "Upload not found", 404);
    }

    const declaredLength = Number(request.headers.get("content-length") || "0");
    const allowed = Number(row.byte_size || 0);
    if (
      declaredLength > maxUploadBytes() ||
      (allowed > 0 && declaredLength > allowed)
    ) {
      throw new AppError(
        "FILE_TOO_LARGE",
        `File too large. Maximum size is ${maxUploadMb()}MB.`,
        413
      );
    }

    const buffer = Buffer.from(await request.arrayBuffer());
    if (buffer.length === 0) {
      throw new AppError("EMPTY_FILE", "File is empty", 400);
    }
    if (
      buffer.length > maxUploadBytes() ||
      (allowed > 0 && buffer.length > allowed)
    ) {
      throw new AppError(
        "FILE_TOO_LARGE",
        `File too large. Maximum size is ${maxUploadMb()}MB.`,
        413
      );
    }

    const sourceName = row.source_path.split("/").pop() || "source.bin";
    await uploadFile(
      `pdfs/${id}`,
      sourceName,
      buffer,
      row.content_type || "application/octet-stream"
    );
    await markUploadUploaded(id);

    return NextResponse.json({ ok: true, bytes: buffer.length });
  } catch (error) {
    if (error instanceof SessionSecretMissingError) {
      return NextResponse.json(
        {
          error:
            "This deployment is missing its session secret, so uploads are disabled.",
        },
        { status: 503 }
      );
    }
    return handleApiError(error);
  }
}
