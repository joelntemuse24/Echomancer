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

export const runtime = "nodejs";

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

export async function POST(request: NextRequest) {
  try {
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
      throw new AppError("FILE_TOO_LARGE", "File too large. Maximum size is 100MB.", 400);
    }

    if (file.size === 0) {
      throw new AppError("EMPTY_FILE", "File is empty", 400);
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let extractedText: string;
    try {
      extractedText = await extractTextFromDocument(buffer, file.name, file.type);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not read text from this document.";
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

    await uploadFile(
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

    return NextResponse.json({
      storagePath: textResult.path,
      fileName: file.name,
      fileSize: file.size,
      format,
      charCount: extractedText.length,
      paragraphCount: extractedText.split(/\n\s*\n/).filter(Boolean).length,
      canonicalFormat: "text/plain; charset=utf-8",
      modelInputPath: textResult.path,
    });
  } catch (error) {
    return handleApiError(error);
  }
}