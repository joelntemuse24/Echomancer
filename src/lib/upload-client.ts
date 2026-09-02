/**
 * Landing-page document intake: presign (tiny JSON) → PUT bytes to storage →
 * complete → poll until Trigger (or local extract) writes content.txt.
 */

export const NETWORK_UPLOAD_ERROR =
  "Couldn't reach storage. Check your connection and try again. Whole books upload directly to storage, not through this site's request limit.";

export const PAYLOAD_TOO_LARGE_ERROR =
  "This file is too large to send through the app server. Refresh and try again — whole books upload directly to storage.";

const EXTRACT_TIMEOUT_MS = 30 * 60 * 1000;
const EXTRACT_POLL_MS = 1000;

export async function readErrorMessage(res: Response): Promise<string> {
  const text = await res.text();
  if (res.status === 413) {
    try {
      const data = JSON.parse(text) as { error?: string };
      if (data.error) return data.error;
    } catch {
      /* Vercel FUNCTION_PAYLOAD_TOO_LARGE is plaintext */
    }
    return PAYLOAD_TOO_LARGE_ERROR;
  }
  const trimmed = text.trim();
  if (!trimmed) return `Upload failed (${res.status})`;
  if (trimmed.startsWith("<") || /function_payload_too_large/i.test(trimmed)) {
    return res.status === 413
      ? PAYLOAD_TOO_LARGE_ERROR
      : "Could not store the file. Please try again.";
  }
  try {
    const data = JSON.parse(trimmed) as { error?: string };
    return data.error || `Upload failed (${res.status})`;
  } catch {
    return trimmed.length > 180
      ? `Upload failed (${res.status})`
      : trimmed;
  }
}

export function networkOrParseError(error: unknown): string {
  if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) {
    return NETWORK_UPLOAD_ERROR;
  }
  if (error instanceof SyntaxError) {
    return PAYLOAD_TOO_LARGE_ERROR;
  }
  if (error instanceof Error) return error.message;
  return "Upload failed";
}

export type UploadPhase = "uploading" | "reading";

export interface UploadedDocument {
  storagePath: string;
  fileName: string;
  charCount: number;
  fileSize: number;
  format: string;
}

interface UploadStatusPayload {
  uploadId?: string;
  status?: string;
  storagePath?: string;
  fileName?: string;
  charCount?: number;
  fileSize?: number;
  format?: string;
  error?: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntilReady(uploadId: string): Promise<UploadStatusPayload> {
  const started = Date.now();
  while (Date.now() - started < EXTRACT_TIMEOUT_MS) {
    const res = await fetch(`/api/pdf/upload/${uploadId}`);
    if (!res.ok) throw new Error(await readErrorMessage(res));
    const data = (await res.json()) as UploadStatusPayload;
    if (data.status === "ready") return data;
    if (data.status === "failed") {
      throw new Error(
        data.error ||
          "Could not extract enough text from this document. It may be scanned, image-based, or DRM-protected."
      );
    }
    await sleep(EXTRACT_POLL_MS);
  }
  throw new Error("Timed out reading this document. Please try again.");
}

export async function uploadBookFile(
  file: File,
  onPhase?: (phase: UploadPhase) => void
): Promise<UploadedDocument> {
  onPhase?.("uploading");

  const presignRes = await fetch("/api/pdf/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type || "application/octet-stream",
      byteSize: file.size,
    }),
  });
  if (!presignRes.ok) throw new Error(await readErrorMessage(presignRes));
  const presign = (await presignRes.json()) as {
    uploadId: string;
    putUrl: string;
    putMethod?: string;
    putHeaders?: Record<string, string>;
  };

  const putHeaders = { ...(presign.putHeaders || {}) };
  // fetch() forbids setting Content-Length; the browser sends it from `file`.
  delete putHeaders["Content-Length"];
  delete putHeaders["content-length"];

  const absolutePut = /^https?:\/\//i.test(presign.putUrl);
  const putRes = await fetch(presign.putUrl, {
    method: presign.putMethod || "PUT",
    headers: putHeaders,
    body: file,
    ...(absolutePut ? { credentials: "omit" as const } : {}),
  });
  if (!putRes.ok) {
    if (putRes.status === 413) throw new Error(PAYLOAD_TOO_LARGE_ERROR);
    throw new Error(await readErrorMessage(putRes));
  }

  onPhase?.("reading");
  const completeRes = await fetch(`/api/pdf/upload/${presign.uploadId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!completeRes.ok) throw new Error(await readErrorMessage(completeRes));
  let data = (await completeRes.json()) as UploadStatusPayload;

  if (data.status !== "ready") {
    data = await pollUntilReady(presign.uploadId);
  }

  if (!data.storagePath) {
    throw new Error("Upload did not return a document path.");
  }

  return {
    storagePath: data.storagePath,
    fileName: data.fileName || file.name,
    charCount: data.charCount ?? 0,
    fileSize: data.fileSize ?? file.size,
    format: data.format || "",
  };
}
