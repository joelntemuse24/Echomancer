/**
 * Browser → storage PUTs. Documents and clone samples never travel through
 * a Vercel function body.
 *
 * Books: presign (tiny JSON) → PUT bytes → complete. Extract continues in
 * the background; voice selection must not wait on it.
 * Clones: presign → PUT bytes → POST /api/tts/clones { uploadId }.
 */

import {
  contentTypeForCloneSample,
  contentTypeForSniffedCloneSample,
  maxCloneSampleBytes,
  maxCloneSampleMb,
  MIN_CLONE_SAMPLE_BYTES,
  sniffCloneSampleFormat,
} from "@/lib/clone-sample-formats";
import {
  contentTypeForSniffedDocument,
  sniffDocumentFormat,
} from "@/lib/document-formats";
import {
  describePickReadError,
  readFileFully,
  reportPickError,
} from "@/lib/file-pick";
import { userFriendlyError } from "@/lib/errors-ui";
import { formatCloneSampleQualityMessage } from "@/lib/tts/clone-sample-quality";

export const NETWORK_UPLOAD_ERROR =
  "Couldn't reach storage. Check your connection.";

export const PAYLOAD_TOO_LARGE_ERROR = "Too large. Refresh and try again.";

export const CLONE_PAYLOAD_TOO_LARGE_ERROR =
  "Too large. Try a shorter recording.";

const EXTRACT_TIMEOUT_MS = 30 * 60 * 1000;
const EXTRACT_POLL_MS = 2000;
/** Backoff for a status poll that failed at the network level (1s → 10s). */
const EXTRACT_POLL_RETRY_BASE_MS = 1000;
const EXTRACT_POLL_RETRY_MAX_MS = 10 * 1000;
/**
 * How many consecutive dead polls to ride out. A phone tab that slept or
 * lost signal mid-book used to surface a raw "Failed to fetch" on the very
 * first miss; now the reader waits through a brief outage and keeps waiting.
 */
const EXTRACT_POLL_MAX_FAILURES = 8;
export const EXTRACT_CONNECTION_LOST_ERROR =
  "Connection lost while reading. Check your connection.";

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

export type UploadPhase = "reading" | "uploading";

export interface UploadProgressOptions {
  onPhase?: (phase: UploadPhase) => void;
  /** 0..1 while the file is fetched from the picker and again while it is PUT. */
  onProgress?: (fraction: number) => void;
}

const FORBIDDEN_PUT_HEADERS = new Set([
  "content-length",
  "host",
  "origin",
  "referer",
]);

function stripForbiddenHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!FORBIDDEN_PUT_HEADERS.has(key.toLowerCase())) out[key] = value;
  }
  return out;
}

interface XhrLike {
  status: number;
  responseText: string;
  open(method: string, url: string, async?: boolean): void;
  setRequestHeader(name: string, value: string): void;
  send(body?: Document | XMLHttpRequestBodyInit | null): void;
  upload: { onprogress: ((event: ProgressEvent) => void) | null };
  onerror: ((event: ProgressEvent) => void) | null;
  onload: ((event: ProgressEvent) => void) | null;
}

/**
 * PUT the bytes with real upload progress. fetch() cannot report upload
 * progress, so browsers go through XHR; environments without XHR (unit
 * tests, server) fall back to fetch. A failing read of a Drive file is
 * reported before any other async work, so NotReadableError never surfaces
 * as a late "Failed to fetch". The body is the already-read bytes, sent
 * as an ArrayBufferView — no second Blob copy of a large book.
 */
async function putBytesToStorage(
  putUrl: string,
  putMethod: string,
  bytes: Uint8Array<ArrayBuffer>,
  headers: Record<string, string>,
  onProgress?: (fraction: number) => void,
  tooLargeMessage: string = PAYLOAD_TOO_LARGE_ERROR
): Promise<void> {
  const safeHeaders = stripForbiddenHeaders(headers);
  const Ctor = (globalThis as { XMLHttpRequest?: new () => XhrLike })
    .XMLHttpRequest;
  if (typeof Ctor !== "function") {
    const res = await fetch(putUrl, {
      method: putMethod,
      headers: safeHeaders,
      body: bytes,
    });
    if (!res.ok) {
      if (res.status === 413) {
        throw new Error(tooLargeMessage);
      }
      throw new Error(await readErrorMessage(res));
    }
    onProgress?.(1);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const xhr = new Ctor();
    xhr.open(putMethod || "PUT", putUrl, true);
    for (const [name, value] of Object.entries(safeHeaders)) {
      try {
        xhr.setRequestHeader(name, value);
      } catch {
        /* forbidden header names are skipped */
      }
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress?.(Math.min(1, event.loaded / event.total));
      }
    };
    xhr.onerror = () => {
      reject(new TypeError("Failed to fetch"));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        resolve();
        return;
      }
      if (xhr.status === 413) {
        reject(new Error(tooLargeMessage));
        return;
      }
      const text = (xhr.responseText || "").trim();
      let message = `Upload failed (${xhr.status})`;
      if (text && !text.startsWith("<")) {
        if (text.length > 180) message = `Upload failed (${xhr.status})`;
        else message = text;
        try {
          const data = JSON.parse(text) as { error?: string };
          if (data.error) message = data.error;
        } catch {
          /* plaintext */
        }
      } else if (text) {
        message = "Couldn't store the file. Try again.";
      }
      reject(new Error(message));
    };
    xhr.send(bytes);
  });
}

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
  subtitle?: string;
  children?: UploadChapter[];
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

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** A 5xx from the status route is the same class of transient miss. */
function isRetryableStatus(status: number): boolean {
  return status >= 500;
}

/** Hidden tabs neither poll nor burn their wait budget; a returning tab polls at once. */
function waitForVisibleTab(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onChange);
      signal?.removeEventListener("abort", onAbort);
    };
    const onChange = () => {
      if (!document.hidden) done();
    };
    const timer = window.setTimeout(done, 1000);
    document.addEventListener("visibilitychange", onChange, { once: false });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Background poll for extracted text. Voice pick / sample play must not wait.
 *
 * One dead poll is not a verdict: network misses back off and retry, and a
 * hidden phone tab neither polls nor spends its budget — it resumes the moment
 * the tab is back. Only a real server answer (`failed`) or a long outage ends
 * the wait.
 */
export async function waitForUploadExtract(
  uploadId: string,
  opts?: { signal?: AbortSignal; timeoutMs?: number; pollMs?: number }
): Promise<UploadStatusPayload> {
  const timeoutMs = opts?.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  const pollMs = opts?.pollMs ?? EXTRACT_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  let consecutiveFailures = 0;

  /** Back off after a dead poll; give up only after a real outage. */
  const retryOrFail = async (): Promise<void> => {
    consecutiveFailures += 1;
    if (consecutiveFailures >= EXTRACT_POLL_MAX_FAILURES) {
      throw new Error(EXTRACT_CONNECTION_LOST_ERROR);
    }
    const backoff = Math.min(
      EXTRACT_POLL_RETRY_BASE_MS * 2 ** (consecutiveFailures - 1),
      EXTRACT_POLL_RETRY_MAX_MS
    );
    await sleep(backoff, opts?.signal);
  };

  while (Date.now() < deadline) {
    if (opts?.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    if (typeof document !== "undefined" && document.hidden) {
      await waitForVisibleTab(opts?.signal);
      continue;
    }
    let res: Response;
    try {
      res = await fetch(`/api/pdf/upload/${uploadId}`, {
        signal: opts?.signal,
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      await retryOrFail();
      continue;
    }
    if (!res.ok && isRetryableStatus(res.status)) {
      await retryOrFail();
      continue;
    }
    if (!res.ok) throw new Error(await readErrorMessage(res));
    consecutiveFailures = 0;
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
  opts?: UploadProgressOptions
): Promise<UploadedDocument> {
  const onPhase = opts?.onPhase;
  const onProgress = opts?.onProgress;

  // Read the file into memory before any other async work. Android
  // content:// grants expire while later awaits run, and Drive reports
  // size 0 until the bytes are pulled; the read fixes both and shows
  // progress while the picker fetches the file.
  onPhase?.("reading");
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await readFileFully(file, onProgress);
  } catch (error) {
    const message = describePickReadError();
    reportPickError("book-upload", message, {
      name: file.name,
      size: file.size,
      error,
    });
    throw new Error(message);
  }
  if (bytes.byteLength === 0) {
    reportPickError("book-upload", "That file is empty.", {
      name: file.name,
      size: file.size,
    });
    throw new Error("That file is empty. Choose another.");
  }

  const sniffed = sniffDocumentFormat(
    bytes.subarray(0, 512 * 1024),
    file.name,
    file.type
  );
  const contentType =
    sniffed !== "unknown"
      ? contentTypeForSniffedDocument(sniffed)
      : file.type || "application/octet-stream";

  onPhase?.("uploading");
  const presignRes = await fetch("/api/pdf/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName: file.name,
      contentType,
      byteSize: bytes.byteLength,
    }),
  });
  if (!presignRes.ok) throw new Error(await readErrorMessage(presignRes));
  const presign = (await presignRes.json()) as {
    uploadId: string;
    putUrl: string;
    putMethod?: string;
    putHeaders?: Record<string, string>;
  };

  // The read bytes are PUT as-is — no second in-memory copy of a large
  // book. The Content-Type travels in the signed headers.
  await putBytesToStorage(
    presign.putUrl,
    presign.putMethod || "PUT",
    bytes,
    presign.putHeaders || {},
    onProgress
  );

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
    fileSize: data.fileSize ?? bytes.byteLength,
    format: data.format || (sniffed !== "unknown" ? sniffed : ""),
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
  } & UploadProgressOptions
): Promise<UploadedCloneVoice> {
  const onPhase = opts?.onPhase;
  const onProgress = opts?.onProgress;

  // Read before any other async work: Android content:// grants expire
  // during later awaits, and a Drive sample can report size 0 until read.
  onPhase?.("reading");
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await readFileFully(file, onProgress);
  } catch (error) {
    const message = describePickReadError();
    reportPickError("clone-sample", message, {
      name: file.name,
      size: file.size,
      error,
    });
    throw new Error(message);
  }

  if (bytes.byteLength > maxCloneSampleBytes()) {
    throw new Error(`Sample must be ${maxCloneSampleMb()} MB or smaller.`);
  }
  if (bytes.byteLength < MIN_CLONE_SAMPLE_BYTES) {
    throw new Error(
      "That sample is too short. Use at least ~10 seconds of clear speech."
    );
  }
  const sniffed = sniffCloneSampleFormat(bytes.subarray(0, 512 * 1024));
  const declaredType = contentTypeForCloneSample(file.name, file.type);
  if (!sniffed && !declaredType) {
    throw new Error("Use an audio or video file: wav, mp3, m4a, opus, ogg, webm, or mp4.");
  }
  const contentType = sniffed
    ? contentTypeForSniffedCloneSample(sniffed)
    : declaredType || file.type || "audio/mpeg";

  onPhase?.("uploading");
  const presignRes = await fetch("/api/tts/clones/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName: file.name,
      contentType,
      byteSize: bytes.byteLength,
    }),
  });
  if (!presignRes.ok) throw new Error(await readErrorMessage(presignRes));
  const presign = (await presignRes.json()) as {
    uploadId: string;
    putUrl: string;
    putMethod?: string;
    putHeaders?: Record<string, string>;
  };

  // The read bytes are PUT as-is — no second in-memory copy of the sample.
  await putBytesToStorage(
    presign.putUrl,
    presign.putMethod || "PUT",
    bytes,
    presign.putHeaders || {},
    onProgress,
    CLONE_PAYLOAD_TOO_LARGE_ERROR
  );

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

/** Rename or relabel an existing clone. Does not retrain Fish. */
export async function updateCloneVoice(
  catalogVoiceId: string,
  patch: { title?: string; accent?: string }
): Promise<UploadedCloneVoice> {
  const res = await fetch(
    `/api/tts/clones/${encodeURIComponent(catalogVoiceId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }
  );
  if (!res.ok) throw new Error(await readErrorMessage(res));
  const data = (await res.json()) as { clone?: UploadedCloneVoice };
  if (!data.clone?.catalogVoiceId) {
    throw new Error("Clone did not return a voice id.");
  }
  return data.clone;
}
