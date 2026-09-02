/**
 * Read a source document from storage, extract text, write content.txt.
 * Runs on Trigger.dev (or in-process in tests / local dev without Trigger).
 * Must never run over a Vercel request body.
 */

import { AppError } from "@/lib/errors";
import { downloadFile, uploadFile } from "@/lib/storage";
import {
  extractTextFromDocument,
  MIN_EXTRACTED_CHARS,
} from "@/lib/text-extraction";
import {
  failUploadExtract,
  finishUploadExtract,
  getUploadById,
  markUploadExtracting,
  uploadStatus,
  type UploadRow,
} from "@/lib/turso/uploads";

export interface UploadPublicView {
  uploadId: string;
  status: string;
  storagePath: string;
  fileName: string;
  fileSize: number;
  format: string;
  charCount: number;
  paragraphCount?: number;
  error?: string | null;
  code?: string;
}

export function toUploadPublicView(
  row: UploadRow,
  extras?: { paragraphCount?: number }
): UploadPublicView {
  const status = uploadStatus(row);
  return {
    uploadId: row.id,
    status,
    storagePath: row.storage_path,
    fileName: row.file_name || "Untitled",
    fileSize: Number(row.byte_size || 0),
    format: row.format || "unknown",
    charCount: Number(row.char_count || 0),
    ...(extras?.paragraphCount != null
      ? { paragraphCount: extras.paragraphCount }
      : {}),
    ...(status === "failed"
      ? { error: row.error_message, code: "EXTRACTION_FAILED" }
      : {}),
  };
}

export async function extractUploadedDocument(
  uploadId: string
): Promise<UploadPublicView> {
  const row = await getUploadById(uploadId);
  if (!row) {
    throw new AppError("UPLOAD_NOT_FOUND", "Upload not found", 404);
  }

  const status = uploadStatus(row);
  if (status === "ready") {
    return toUploadPublicView(row);
  }
  if (status === "pending") {
    throw new AppError(
      "FILE_MISSING",
      "The document has not finished uploading yet.",
      400
    );
  }
  if (status === "failed" && row.error_message) {
    return toUploadPublicView(row);
  }

  await markUploadExtracting(uploadId);

  const sourcePath = row.source_path;
  if (!sourcePath) {
    const message = "Upload is missing its source file.";
    await failUploadExtract(uploadId, message);
    return toUploadPublicView({
      ...row,
      status: "failed",
      error_message: message,
    });
  }

  let buffer: Buffer;
  try {
    buffer = await downloadFile(sourcePath);
  } catch (err) {
    // Transient storage miss — throw so Trigger retries.
    throw new Error(
      `Failed to download ${sourcePath}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  if (!buffer.length) {
    const message = "The uploaded file appears to be empty.";
    await failUploadExtract(uploadId, message);
    return toUploadPublicView({
      ...row,
      status: "failed",
      error_message: message,
    });
  }

  let extractedText: string;
  try {
    extractedText = await extractTextFromDocument(
      buffer,
      row.file_name || sourcePath,
      row.content_type || undefined
    );
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Could not read text from this document.";
    await failUploadExtract(uploadId, message);
    return toUploadPublicView({
      ...row,
      status: "failed",
      error_message: message,
    });
  }

  if (extractedText.length < MIN_EXTRACTED_CHARS) {
    const message =
      "Could not extract enough text from this document. It may be scanned, image-based, or DRM-protected.";
    await failUploadExtract(uploadId, message);
    return toUploadPublicView({
      ...row,
      status: "failed",
      error_message: message,
    });
  }

  await uploadFile(
    `pdfs/${uploadId}`,
    "content.txt",
    Buffer.from(extractedText, "utf-8"),
    "text/plain; charset=utf-8"
  );

  await finishUploadExtract(uploadId, { charCount: extractedText.length });

  const ready = await getUploadById(uploadId);
  if (!ready) {
    throw new AppError("UPLOAD_NOT_FOUND", "Upload not found", 404);
  }

  return toUploadPublicView(ready, {
    paragraphCount: extractedText.split(/\n\s*\n/).filter(Boolean).length,
  });
}
