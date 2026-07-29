import { NextRequest, NextResponse } from "next/server";
import { AppError, handleApiError } from "@/lib/errors";
import { randomUUID } from "crypto";
import {
  SUPPORTED_DOCUMENT_EXTENSIONS,
  detectFormat,
  extractTextFromDocument,
  MIN_EXTRACTED_CHARS,
} from "@/lib/text-extraction";
import { uploadFile } from "@/lib/storage";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import {
  attachSessionCookie,
  readOrMintSession,
  SessionSecretMissingError,
} from "@/lib/auth/session";
import { recordUpload } from "@/lib/turso/uploads";
import {
  clientIp,
  createRateLimiter,
  rateLimitIdentity,
} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Upload ceiling. Text extraction runs in-process on the whole buffer, so this
 * is a memory bound as much as a storage one: an unbounded upload is the
 * cheapest way to knock over a serverless function.
 */
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || "25");
const MAX_FILE_SIZE = MAX_UPLOAD_MB * 1024 * 1024;

// Extraction is expensive and the endpoint is reachable before a user has done
// anything else, so the limiter fails closed.
const uploadRateLimit = createRateLimiter(10, 60_000, { onError: "closed" });

export async function POST(request: NextRequest) {
  try {
    await ensureTtsJobColumns();

    // Uploading is where an anonymous visitor gets an identity: the response
    // carries the session cookie that later proves they own this document.
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

    // Reject oversized bodies before buffering them into memory.
    const declaredLength = Number(request.headers.get("content-length") || "0");
    if (declaredLength > MAX_FILE_SIZE) {
      throw new AppError(
        "FILE_TOO_LARGE",
        `File too large. Maximum size is ${MAX_UPLOAD_MB}MB.`,
        413
      );
    }

    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      throw new AppError("MISSING_FILE", "No file provided", 400);
    }

    const format = detectFormat(file.name, file.type);
    if (format === "unknown") {
      throw new AppError(
        "INVALID_TYPE",
        `Unsupported format. Accepted: .${SUPPORTED_DOCUMENT_EXTENSIONS.join(", ")}`,
        400
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      throw new AppError(
        "FILE_TOO_LARGE",
        `File too large. Maximum size is ${MAX_UPLOAD_MB}MB.`,
        413
      );
    }

    if (file.size === 0) {
      throw new AppError("EMPTY_FILE", "File is empty", 400);
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    let extractedText: string;
    try {
      extractedText = await extractTextFromDocument(buffer, file.name, file.type);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Could not read text from this document.";
      throw new AppError("EXTRACTION_FAILED", message, 400);
    }

    if (extractedText.length < MIN_EXTRACTED_CHARS) {
      throw new AppError(
        "EXTRACTION_FAILED",
        "Could not extract enough text from this document. It may be scanned, image-based, or DRM-protected.",
        400
      );
    }

    const fileId = randomUUID();
    const basePath = `pdfs/${fileId}`;
    const sourceExt = file.name.split(".").pop()?.toLowerCase() || format;

    const sourceResult = await uploadFile(
      basePath,
      `source.${sourceExt}`,
      buffer,
      file.type || "application/octet-stream"
    );

    const textResult = await uploadFile(
      basePath,
      "content.txt",
      Buffer.from(extractedText, "utf-8"),
      "text/plain; charset=utf-8"
    );

    await recordUpload({
      id: fileId,
      userId: session.userId,
      storagePath: textResult.path,
      sourcePath: sourceResult.path,
      fileName: file.name,
      format,
      byteSize: file.size,
      charCount: extractedText.length,
    });

    const response = NextResponse.json({
      storagePath: textResult.path,
      fileName: file.name,
      fileSize: file.size,
      format,
      charCount: extractedText.length,
      paragraphCount: extractedText.split(/\n\s*\n/).filter(Boolean).length,
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
