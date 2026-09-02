/**
 * POST /api/pdf/upload — mint a short-lived storage PUT.
 *
 * Tiny JSON only: { fileName, contentType, byteSize }. The browser PUTs the
 * document to R2 (or a local object route in development). Extraction runs on
 * Trigger.dev after complete — never over this function body.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";
import { AppError, handleApiError } from "@/lib/errors";
import {
  SUPPORTED_DOCUMENT_EXTENSIONS,
  contentTypeForDocument,
  detectFormat,
  maxUploadBytes,
  maxUploadMb,
} from "@/lib/document-formats";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import {
  attachSessionCookie,
  readOrMintSession,
  SessionSecretMissingError,
} from "@/lib/auth/session";
import { insertPendingUpload } from "@/lib/turso/uploads";
import {
  clientIp,
  rateLimitIdentity,
} from "@/lib/rate-limit";
import { uploadRateLimit } from "@/lib/uploads/rate-limit";
import {
  rejectMultipartUpload,
  rejectOversizedFunctionBody,
} from "@/lib/uploads/http";
import { assertCanDispatchExtract } from "@/lib/jobs/trigger-extract";
import { isProductionDispatch } from "@/lib/jobs/trigger-takehome";
import {
  PRESIGN_EXPIRES_SECONDS,
  getUploadUrl,
  isR2Configured,
} from "@/lib/r2-storage";

export const runtime = "nodejs";
export const maxDuration = 30;

const presignSchema = z.object({
  fileName: z.string().trim().min(1).max(240),
  contentType: z.string().trim().max(200).optional(),
  byteSize: z.number().int().positive(),
});

export async function POST(request: NextRequest) {
  try {
    await ensureTtsJobColumns();
    rejectMultipartUpload(request);
    rejectOversizedFunctionBody(request);

    const { session, minted } = await readOrMintSession(request);

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
    const format = detectFormat(fileName, parsed.data.contentType);
    if (format === "unknown") {
      throw new AppError(
        "INVALID_TYPE",
        `Unsupported format. Accepted: .${SUPPORTED_DOCUMENT_EXTENSIONS.join(", ")}`,
        400
      );
    }

    const uploadCeiling = maxUploadBytes();
    if (byteSize > uploadCeiling) {
      throw new AppError(
        "FILE_TOO_LARGE",
        `File too large. Maximum size is ${maxUploadMb()}MB.`,
        413
      );
    }

    assertCanDispatchExtract();
    if (isProductionDispatch() && !isR2Configured()) {
      throw new AppError(
        "STORAGE_NOT_CONFIGURED",
        "Object storage is not configured, so document uploads are disabled.",
        503
      );
    }

    const contentType = contentTypeForDocument(
      fileName,
      parsed.data.contentType
    );
    const fileId = randomUUID();
    const sourceExt = fileName.split(".").pop()?.toLowerCase() || format;
    const sourcePath = `pdfs/${fileId}/source.${sourceExt}`;
    const storagePath = `pdfs/${fileId}/content.txt`;

    await insertPendingUpload({
      id: fileId,
      userId: session.userId,
      storagePath,
      sourcePath,
      fileName,
      format,
      byteSize,
      contentType,
    });

    const putHeaders: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Length": String(byteSize),
    };

    let putUrl: string;
    if (isR2Configured()) {
      putUrl = await getUploadUrl(sourcePath, {
        contentType,
        contentLength: byteSize,
      });
    } else {
      putUrl = `/api/pdf/upload/${fileId}/object`;
    }

    const response = NextResponse.json({
      uploadId: fileId,
      putUrl,
      putMethod: "PUT",
      putHeaders,
      storagePath,
      sourcePath,
      expiresIn: PRESIGN_EXPIRES_SECONDS,
    });

    if (minted) attachSessionCookie(response, session);
    return response;
  } catch (error) {
    if (error instanceof SessionSecretMissingError) {
      console.error("[upload]", error.message);
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
