/**
 * GET  /api/pdf/upload/[id] — poll extraction status (owner only).
 * POST /api/pdf/upload/[id] — complete after the browser PUT; enqueue extract.
 *
 * Complete never downloads the source. It HEADs storage, then Trigger (or
 * in-process in tests) reads the file from R2/local disk.
 */

import { NextRequest, NextResponse } from "next/server";
import { AppError, handleApiError } from "@/lib/errors";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { SessionSecretMissingError } from "@/lib/auth/session";
import { requireSession } from "@/lib/auth/guard";
import {
  getUploadByIdForUser,
  markUploadUploaded,
  uploadStatus,
} from "@/lib/turso/uploads";
import { getFileMetadata } from "@/lib/storage";
import { maxUploadBytes, maxUploadMb } from "@/lib/document-formats";
import { clientIp, rateLimitIdentity } from "@/lib/rate-limit";
import { uploadRateLimit } from "@/lib/uploads/rate-limit";
import {
  rejectMultipartUpload,
  rejectOversizedFunctionBody,
} from "@/lib/uploads/http";
import { dispatchUploadExtract } from "@/lib/jobs/trigger-extract";
import { toUploadPublicView } from "@/lib/uploads/extract";

export const runtime = "nodejs";
export const maxDuration = 60;

async function ownedUpload(request: NextRequest, id: string) {
  const session = await requireSession(request);
  const row = await getUploadByIdForUser(session.userId, id);
  if (!row) {
    throw new AppError("NOT_FOUND", "Upload not found", 404);
  }
  return { session, row };
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await ensureTtsJobColumns();
    const { id } = await context.params;
    const { row } = await ownedUpload(request, id);
    return NextResponse.json(toUploadPublicView(row));
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

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await ensureTtsJobColumns();
    rejectMultipartUpload(request);
    rejectOversizedFunctionBody(request);

    const { id } = await context.params;
    const { session, row } = await ownedUpload(request, id);

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

    const status = uploadStatus(row);
    if (status === "ready") {
      return NextResponse.json(toUploadPublicView(row));
    }
    if (status === "failed") {
      return NextResponse.json(toUploadPublicView(row), { status: 400 });
    }
    if (status === "extracting") {
      return NextResponse.json(toUploadPublicView(row));
    }

    const sourcePath = row.source_path;
    if (!sourcePath) {
      throw new AppError(
        "FILE_MISSING",
        "The document has not finished uploading yet.",
        400
      );
    }

    const meta = await getFileMetadata(sourcePath);
    if (!meta || meta.size <= 0) {
      throw new AppError(
        "FILE_MISSING",
        "The document has not finished uploading yet.",
        400
      );
    }

    const declared = Number(row.byte_size || 0);
    if (meta.size > maxUploadBytes() || (declared > 0 && meta.size > declared)) {
      throw new AppError(
        "FILE_TOO_LARGE",
        `File too large. Maximum size is ${maxUploadMb()}MB.`,
        413
      );
    }

    await markUploadUploaded(id);
    await dispatchUploadExtract(id);

    const latest = await getUploadByIdForUser(session.userId, id);
    if (!latest) {
      throw new AppError("NOT_FOUND", "Upload not found", 404);
    }
    if (uploadStatus(latest) === "failed") {
      return NextResponse.json(toUploadPublicView(latest), { status: 400 });
    }
    return NextResponse.json(toUploadPublicView(latest));
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
