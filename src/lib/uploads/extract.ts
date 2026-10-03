/**
 * Read a source document from storage, extract text, write content.txt.
 * The parse itself is `runUploadExtract` — the same function the Cloudflare
 * Worker runs. This wrapper is the Node side (VM child, Vercel `after()`,
 * or in-process in tests). Must never run over a Vercel request body.
 */

import type { ChaptersDocument } from "@/lib/book-chapters";
import { AppError } from "@/lib/errors";
import { downloadFile, uploadFile } from "@/lib/storage";
import { scheduleListenPrep } from "@/lib/tts/listen-prep-cache";
import type { ExtractHost } from "@/lib/uploads/extract-route";
import {
  runUploadExtract,
  type ExtractIo,
  type ExtractSnapshot,
} from "@/lib/uploads/run-extract";
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
  chapterSource?: ChaptersDocument["source"];
  chapters?: ChaptersDocument["chapters"];
}

export function toUploadPublicView(
  row: UploadRow,
  extras?: { paragraphCount?: number; chapters?: ChaptersDocument }
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
    ...(extras?.chapters
      ? {
          chapterSource: extras.chapters.source,
          chapters: extras.chapters.chapters,
        }
      : {}),
  };
}

function snapshotOf(row: UploadRow): ExtractSnapshot {
  return {
    status: row.status,
    sourcePath: row.source_path,
    fileName: row.file_name,
    contentType: row.content_type,
    errorMessage: row.error_message,
    extractHost: row.extract_host ?? null,
  };
}

function nodeExtractIo(host: ExtractHost): ExtractIo {
  return {
    async load(uploadId) {
      const row = await getUploadById(uploadId);
      return row ? snapshotOf(row) : null;
    },
    claim(uploadId) {
      return markUploadExtracting(uploadId, host);
    },
    fail(uploadId, claimHost, message) {
      return failUploadExtract(uploadId, message, claimHost);
    },
    finish(uploadId, claimHost, charCount) {
      return finishUploadExtract(uploadId, { charCount, host: claimHost });
    },
    async readSource(path) {
      try {
        const buffer = await downloadFile(path);
        return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      } catch (err) {
        throw new Error(
          `Failed to download ${path}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    },
    async writeObject(key, bytes, contentType) {
      const slash = key.lastIndexOf("/");
      const directory = slash >= 0 ? key.slice(0, slash) : "";
      const filename = slash >= 0 ? key.slice(slash + 1) : key;
      await uploadFile(directory, filename, Buffer.from(bytes), contentType);
    },
  };
}

export async function extractUploadedDocument(
  uploadId: string,
  options?: { host?: ExtractHost }
): Promise<UploadPublicView> {
  const host = options?.host ?? "inline";
  const row = await getUploadById(uploadId);
  if (!row) {
    throw new AppError("UPLOAD_NOT_FOUND", "That upload is gone. Start again.", 404);
  }

  const status = uploadStatus(row);
  if (status === "ready") {
    return toUploadPublicView(row);
  }
  if (status === "pending") {
    throw new AppError(
      "FILE_MISSING",
      "Still uploading. Try again in a moment.",
      400
    );
  }
  if (status === "failed" && row.error_message) {
    return toUploadPublicView(row);
  }

  const result = await runUploadExtract(uploadId, host, nodeExtractIo(host));
  if (result.outcome === "missing") {
    throw new AppError("UPLOAD_NOT_FOUND", "That upload is gone. Start again.", 404);
  }
  if (result.outcome === "pending") {
    throw new AppError(
      "FILE_MISSING",
      "Still uploading. Try again in a moment.",
      400
    );
  }

  const ready = await getUploadById(uploadId);
  if (!ready) {
    throw new AppError("UPLOAD_NOT_FOUND", "That upload is gone. Start again.", 404);
  }
  if (result.outcome === "ready") {
    scheduleListenPrep(uploadId);
    return toUploadPublicView(ready, {
      paragraphCount: result.text.split(/\n\s*\n/).filter(Boolean).length,
      chapters: result.chapters,
    });
  }
  return toUploadPublicView(ready);
}

export { readUploadChapters } from "@/lib/uploads/chapters-store";
