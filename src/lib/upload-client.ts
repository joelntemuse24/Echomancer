/**
 * Browser → storage PUTs. Documents and clone samples never travel through
 * a Vercel function body.
 *
 * Books: presign (tiny JSON) → PUT bytes → complete. Extract continues in
 * the background; voice selection must not wait on it.
 * Clones: presign → PUT bytes → POST /api/tts/clones { uploadId }.
 */

import {
  isAllowedCloneSample,
  maxCloneSampleBytes,
  maxCloneSampleMb,
  MIN_CLONE_SAMPLE_BYTES,
} from "@/lib/clone-sample-formats";
import { userFriendlyError } from "@/lib/errors-ui";
import { formatCloneSampleQualityMessage } from "@/lib/tts/clone-sample-quality";

export const NETWORK_UPLOAD_ERROR =
  "Couldn't reach storage. Check your connection.";

export const PAYLOAD_TOO_LARGE_ERROR = "Too large. Refresh and try again.";

export const CLONE_PAYLOAD_TOO_LARGE_ERROR =
  "Too large. Try a shorter recording.";

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
      : "Couldn't store the file. Try again.";
  }
  try {
    const data = JSON.parse(trimmed) as {
      error?: string;
      verdict?: string;
      headline?: string;
      primary_message?: string;
    };
    if (data.verdict === "fail" && (data.headline || data.primary_message)) {
      return formatCloneSampleQualityMessage({
        headline: data.headline || "",
        primary_message: data.primary_message || "",
      });
    }
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
  if (error instanceof Error) {
    if (error.message.toLowerCase().includes("could not find file in options")) {
      return userFriendlyError(error.message);
    }
    return error.message;
  }
  return "Upload failed. Try again.";
}

export type UploadPhase = "uploading";

export interface UploadedDocument {
  storagePath: string;
  fileName: string;
  charCount: number;
  fileSize: number;
  format: string;
  uploadId: string;
  status: string;
}

const UPLOAD_ID_IN_PATH =
  /^pdfs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i;

export function uploadIdFromStoragePath(path: string): string | null {
  return UPLOAD_ID_IN_PATH.exec(path)?.[1] ?? null;
}

export interface UploadChapter {
  index: number;
  title: string;
  level: number;
  charStart: number;
  charEnd: number;
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
  chapterSource?: string;
  chapters?: UploadChapter[];
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Background poll for extracted text. Voice pick / sample play must not wait. */
export async function waitForUploadExtract(
  uploadId: string,
  opts?: { signal?: AbortSignal; timeoutMs?: number; pollMs?: number }
): Promise<UploadStatusPayload> {
  const timeoutMs = opts?.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  const pollMs = opts?.pollMs ?? EXTRACT_POLL_MS;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (opts?.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const res = await fetch(`/api/pdf/upload/${uploadId}`, {
      signal: opts?.signal,
    });
    if (!res.ok) throw new Error(await readErrorMessage(res));
    const data = (await res.json()) as UploadStatusPayload;
    if (data.status === "ready") return data;
    if (data.status === "failed") {
      throw new Error(
        data.error ||
          "Couldn't read this. Try another file."
      );
    }
    await sleep(pollMs, opts?.signal);
  }
  throw new Error("Reading timed out. Try again.");
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

  const completeRes = await fetch(`/api/pdf/upload/${presign.uploadId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!completeRes.ok) throw new Error(await readErrorMessage(completeRes));
  const data = (await completeRes.json()) as UploadStatusPayload;

  if (data.status === "failed") {
    throw new Error(
      data.error ||
        "Couldn't read this. Try another file."
    );
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
    uploadId: data.uploadId || presign.uploadId,
    status: data.status || "extracting",
  };
}

export type UploadedCloneVoice = {
  catalogVoiceId: string;
  displayName: string;
  state?: string;
  createdAt?: number;
};

export async function uploadCloneVoice(
  file: File,
  opts?: {
    title?: string;
    transcript?: string;
    accent?: string;
    youtube?: { videoId: string; startSec: number; endSec: number };
  }
): Promise<UploadedCloneVoice> {
  if (file.size > maxCloneSampleBytes()) {
    throw new Error(`Sample must be ${maxCloneSampleMb()} MB or smaller.`);
  }
  if (file.size < MIN_CLONE_SAMPLE_BYTES) {
    throw new Error(
      "That sample is too short. Use at least ~10 seconds of clear speech."
    );
  }
  if (!isAllowedCloneSample(file.name, file.type)) {
    throw new Error("Use wav, mp3, m4a, opus, ogg, or webm samples.");
  }

  const presignRes = await fetch("/api/tts/clones/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type || "audio/mpeg",
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
    if (putRes.status === 413) throw new Error(CLONE_PAYLOAD_TOO_LARGE_ERROR);
    throw new Error(await readErrorMessage(putRes));
  }

  return completeCloneUpload(presign.uploadId, opts);
}

export type CloneQualityRisk = {
  headline: string;
  body: string;
  issues: { code: string; detail: string }[];
};

/**
 * The reference gate thinks this clip may not clone well. Nothing is lost:
 * the sample stays uploaded, so "Continue anyway" calls
 * `completeCloneUpload(uploadId, opts, { acceptQualityRisk: true })`.
 */
export class CloneQualityRiskError extends Error {
  constructor(
    public uploadId: string,
    public risk: CloneQualityRisk
  ) {
    super(risk.headline);
    this.name = "CloneQualityRiskError";
  }
}

/** Create the clone from an already uploaded sample. */
export async function completeCloneUpload(
  uploadId: string,
  opts?: {
    title?: string;
    transcript?: string;
    accent?: string;
    youtube?: { videoId: string; startSec: number; endSec: number };
  },
  extra?: { acceptQualityRisk?: boolean }
): Promise<UploadedCloneVoice> {
  const completeRes = await fetch("/api/tts/clones", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      uploadId,
      title: opts?.title,
      transcript: opts?.transcript,
      ...(opts?.accent ? { accent: opts.accent } : {}),
      ...(extra?.acceptQualityRisk ? { acceptQualityRisk: true } : {}),
      ...(opts?.youtube
        ? {
            youtube: {
              videoId: opts.youtube.videoId,
              startSec: opts.youtube.startSec,
              endSec: opts.youtube.endSec,
              consent: true,
            },
          }
        : {}),
    }),
  });
  if (completeRes.status === 409) {
    const data = (await completeRes
      .clone()
      .json()
      .catch(() => null)) as {
      code?: string;
      quality?: { headline?: string; body?: string; issues?: { code: string; detail: string }[] };
    } | null;
    if (data?.code === "SAMPLE_RISKY") {
      throw new CloneQualityRiskError(uploadId, {
        headline: data.quality?.headline || "This clip may not clone well.",
        body: data.quality?.body || "Try a cleaner clip.",
        issues: Array.isArray(data.quality?.issues) ? data.quality.issues : [],
      });
    }
  }
  if (!completeRes.ok) throw new Error(await readErrorMessage(completeRes));
  const data = (await completeRes.json()) as {
    clone?: UploadedCloneVoice;
  };
  if (!data.clone?.catalogVoiceId) {
    throw new Error("Clone did not return a voice id.");
  }
  return data.clone;
}

/** Relabel an existing clone (`clone:<id>` or the row id). Does not retrain Fish. */
export async function updateCloneAccent(
  catalogVoiceId: string,
  accent: string
): Promise<UploadedCloneVoice> {
  const res = await fetch(
    `/api/tts/clones/${encodeURIComponent(catalogVoiceId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accent }),
    }
  );
  if (!res.ok) throw new Error(await readErrorMessage(res));
  const data = (await res.json()) as { clone?: UploadedCloneVoice };
  if (!data.clone?.catalogVoiceId) {
    throw new Error("Clone did not return a voice id.");
  }
  return data.clone;
}
