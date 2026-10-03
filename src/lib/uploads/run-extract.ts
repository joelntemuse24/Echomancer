/**
 * Shared document extract. The Cloudflare Worker and the Node worker both
 * call this. Storage and the uploads row are injected so this file does not
 * pull the Node Turso client or the S3 SDK into the Worker bundle.
 *
 * Output is the same on both hosts: speakable `content.txt`, `chapters.json`,
 * and `uploads.status`. A second finisher sees `ready` and does not overwrite
 * a failed or ready row owned by the other host.
 */

import {
  CHAPTERS_JSON_NAME,
  emptyChapters,
  safeResolveChapters,
  type ChaptersDocument,
} from "@/lib/book-chapters";
import {
  extractDocument,
  MIN_EXTRACTED_CHARS,
} from "@/lib/text-extraction";
import { toSpeakableText } from "@/lib/tts/speakable-text";
import type { ExtractHost } from "@/lib/uploads/extract-route";

export const EXTRACT_EMPTY_MESSAGE = "The uploaded file appears to be empty.";
export const EXTRACT_MISSING_SOURCE_MESSAGE =
  "Upload is missing its source file.";
export const EXTRACT_TOO_SHORT_MESSAGE =
  "Couldn't read this. Try another file.";

export interface ExtractSnapshot {
  status: string | null;
  sourcePath: string | null;
  fileName: string | null;
  contentType: string | null;
  errorMessage: string | null;
  extractHost: string | null;
}

export interface ExtractIo {
  load(uploadId: string): Promise<ExtractSnapshot | null>;
  /** False when another host already owns the row. */
  claim(uploadId: string, host: ExtractHost): Promise<boolean>;
  fail(uploadId: string, host: ExtractHost, message: string): Promise<void>;
  finish(uploadId: string, host: ExtractHost, charCount: number): Promise<void>;
  /** Throws on a transient storage error. Null when the object is gone. */
  readSource(path: string): Promise<Uint8Array | null>;
  writeObject(
    key: string,
    bytes: Uint8Array,
    contentType: string
  ): Promise<void>;
}

export type ExtractRunResult =
  | {
      outcome: "ready";
      charCount: number;
      text: string;
      chapters: ChaptersDocument;
    }
  | { outcome: "failed"; message: string }
  | { outcome: "skipped" }
  | { outcome: "missing" }
  | { outcome: "pending" };

function owns(row: ExtractSnapshot, host: ExtractHost): boolean {
  if (row.status !== "extracting") return false;
  if (row.extractHost === host) return true;
  // Vercel `after()` marks extracting without a host, then parses inline.
  if (row.extractHost == null && host === "inline") return true;
  return false;
}

/**
 * Parse one upload and write the same objects the Cloudflare Worker writes.
 * Download failures throw so the caller can retry. Parse failures mark the
 * row failed unless it is already `ready`.
 */
export async function runUploadExtract(
  uploadId: string,
  host: ExtractHost,
  io: ExtractIo
): Promise<ExtractRunResult> {
  const row = await io.load(uploadId);
  if (!row) return { outcome: "missing" };
  if (row.status === "ready") return { outcome: "skipped" };
  if (row.status === "pending") return { outcome: "pending" };
  if (row.status === "failed" && row.errorMessage) {
    return { outcome: "failed", message: row.errorMessage };
  }

  if (!owns(row, host)) {
    const claimed = await io.claim(uploadId, host);
    if (!claimed) {
      const latest = await io.load(uploadId);
      if (!latest || latest.status === "ready") return { outcome: "skipped" };
      if (latest.extractHost && latest.extractHost !== host) {
        return { outcome: "skipped" };
      }
    }
  }

  const sourcePath = row.sourcePath;
  if (!sourcePath) {
    await io.fail(uploadId, host, EXTRACT_MISSING_SOURCE_MESSAGE);
    return { outcome: "failed", message: EXTRACT_MISSING_SOURCE_MESSAGE };
  }

  const bytes = await io.readSource(sourcePath);
  if (bytes == null) {
    throw new Error(`Failed to download ${sourcePath}`);
  }
  if (bytes.byteLength === 0) {
    await io.fail(uploadId, host, EXTRACT_EMPTY_MESSAGE);
    return { outcome: "failed", message: EXTRACT_EMPTY_MESSAGE };
  }

  let extractedText: string;
  let chapters: ChaptersDocument = emptyChapters();
  try {
    const extracted = await extractDocument(
      bytes,
      row.fileName || sourcePath,
      row.contentType || undefined
    );
    extractedText = toSpeakableText(extracted.text, { normalizeTitles: false });
    chapters = safeResolveChapters(extractedText, extracted.hint);
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Could not read text from this document.";
    await io.fail(uploadId, host, message);
    return { outcome: "failed", message };
  }

  if (extractedText.length < MIN_EXTRACTED_CHARS) {
    await io.fail(uploadId, host, EXTRACT_TOO_SHORT_MESSAGE);
    return { outcome: "failed", message: EXTRACT_TOO_SHORT_MESSAGE };
  }

  const beforeWrite = await io.load(uploadId);
  if (beforeWrite?.status === "ready") return { outcome: "skipped" };
  if (beforeWrite?.extractHost && beforeWrite.extractHost !== host) {
    return { outcome: "skipped" };
  }

  const encoder = new TextEncoder();
  await io.writeObject(
    `pdfs/${uploadId}/content.txt`,
    encoder.encode(extractedText),
    "text/plain; charset=utf-8"
  );

  try {
    await io.writeObject(
      `pdfs/${uploadId}/${CHAPTERS_JSON_NAME}`,
      encoder.encode(JSON.stringify(chapters)),
      "application/json"
    );
  } catch (err) {
    console.error(`[extract] chapters.json failed for ${uploadId}`, err);
    chapters = emptyChapters();
  }

  const beforeFinish = await io.load(uploadId);
  if (beforeFinish?.status === "ready") return { outcome: "skipped" };
  if (beforeFinish?.extractHost && beforeFinish.extractHost !== host) {
    return { outcome: "skipped" };
  }

  await io.finish(uploadId, host, extractedText.length);
  const after = await io.load(uploadId);
  if (after?.status === "ready") {
    return {
      outcome: "ready",
      charCount: extractedText.length,
      text: extractedText,
      chapters,
    };
  }
  if (after?.extractHost && after.extractHost !== host) {
    return { outcome: "skipped" };
  }
  if (after?.status === "failed" && after.errorMessage) {
    return { outcome: "failed", message: after.errorMessage };
  }
  throw new Error(`Extract finish did not land for ${uploadId}`);
}
