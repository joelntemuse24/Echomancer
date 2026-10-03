/**
 * Pick-time file handling shared by the book and clone-sample inputs.
 *
 * Phones pick files from Google Drive / iCloud / Files through lazy
 * content providers: the File may report size 0 until it is read, an
 * empty or octet-stream MIME, a stripped extension, and reading it after
 * an await throws NotReadableError (Android content:// grants expire).
 * So the moment a file is picked we read bytes — before any other async
 * work — sniff the format from magic bytes, and turn every bail-out into
 * a visible, logged message instead of a silent no-op.
 *
 * No Node imports: this module ships to the browser bundle.
 */

import {
  GOOGLE_DOCS_UPLOAD_MESSAGE,
  isGoogleAppsDocumentEntry,
  looksLikePlainText,
  maxUploadBytes,
  maxUploadMb,
  sniffDocumentFormat,
  isAcceptableUploadDeclaration,
} from "@/lib/document-formats";
import {
  contentTypeForCloneSample,
  maxCloneSampleBytes,
  maxCloneSampleMb,
  sniffCloneSampleFormat,
} from "@/lib/clone-sample-formats";

export const FILE_UNREADABLE_MESSAGE =
  "Couldn't read that file. If it's from Drive or Files, download it to your device and try again.";
export const UNSUPPORTED_BOOK_MESSAGE =
  "Use EPUB, PDF, DOCX, TXT, RTF, or MOBI.";
export const UNSUPPORTED_SAMPLE_MESSAGE =
  "Use an audio or video file: wav, mp3, m4a, opus, ogg, webm, or mp4.";
export const SAMPLE_PREP_FAILED_MESSAGE =
  "Couldn't prepare that sample. Try another file.";
export const VIDEO_AUDIO_DECODE_FAILED_MESSAGE =
  "Couldn't read audio from that video. Export it as an audio file, then pick that.";
export { GOOGLE_DOCS_UPLOAD_MESSAGE };

export type FilePickResult =
  | { ok: true; format: string }
  | { ok: false; message: string; reason: string };

/** Read the first `maxBytes` of a picked file, promptly, for sniffing. */
export async function readFileHead(
  file: Blob,
  maxBytes: number
): Promise<Uint8Array<ArrayBuffer>> {
  // A lazy Drive pick can report size 0: Blob.slice() clamps to that
  // reported size and would return nothing. So a size-0 file is read
  // directly, forcing the provider to produce the bytes; only a read
  // that truly returns 0 bytes or throws counts as unreadable.
  if (file.size > 0 && file.size < maxBytes) {
    return new Uint8Array(await file.arrayBuffer());
  }
  if (file.size > 0) {
    return new Uint8Array(await file.slice(0, maxBytes).arrayBuffer());
  }
  const full = new Uint8Array(await file.arrayBuffer());
  return full.byteLength > maxBytes ? full.slice(0, maxBytes) : full;
}

type ProgressFn = (fraction: number) => void;

/**
 * Read the whole file into memory with progress, before any other async
 * work touches the File handle. FileReader drives the progress events (the
 * OS fetching the file from Drive is part of this read); when FileReader is
 * unavailable (Node tests) falls back to Blob.arrayBuffer().
 */
export async function readFileFully(
  file: Blob,
  onProgress?: ProgressFn
): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof FileReader === "undefined") {
    onProgress?.(1);
    return new Uint8Array(await file.arrayBuffer());
  }
  return new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress?.(Math.min(1, event.loaded / event.total));
      }
    };
    reader.onerror = () => {
      reject(reader.error ?? new DOMException("Read failed", "NotReadableError"));
    };
    reader.onabort = () => {
      reject(new DOMException("Aborted", "AbortError"));
    };
    reader.onload = () => {
      onProgress?.(1);
      resolve(new Uint8Array(reader.result as ArrayBuffer));
    };
    reader.readAsArrayBuffer(file);
  });
}

/** Map a failed read to a message that says what to do on a phone. */
export function describePickReadError(): string {
  // NotReadableError (Android content:// grant gone), SecurityError, and
  // every other read failure get the same instruction: download the file,
  // then pick again. The raw error is logged by reportPickError.
  return FILE_UNREADABLE_MESSAGE;
}

/** True for genuine read failures (NotReadableError and the like), not decode or other prep errors. */
export function isFileReadError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    [
      "NotReadableError",
      "SecurityError",
      "NotFoundError",
      "AbortError",
    ].includes(error.name)
  );
}

/** Log a pick-time failure to the browser console and the server (best effort). */
export function reportPickError(
  tag: "book-upload" | "clone-sample",
  message: string,
  detail?: unknown
): void {
  console.error(`[${tag}] ${message}`, detail ?? "");
  try {
    void fetch("/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tag,
        message: message.slice(0, 500),
        detail:
          detail instanceof Error
            ? `${detail.name}: ${detail.message}`.slice(0, 300)
            : undefined,
      }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* logging must never break the pick */
  }
}

function fail(reason: string, message: string): FilePickResult {
  return { ok: false, reason, message };
}

/**
 * Validate a picked book by reading its head and sniffing magic bytes.
 * Never trusts file.name or file.type alone: Drive strips extensions and
 * reports empty / octet-stream MIME for real books.
 */
export async function validateBookFilePick(
  file: File
): Promise<FilePickResult> {
  if (isGoogleAppsDocumentEntry(file.name, file.type)) {
    reportPickError("book-upload", GOOGLE_DOCS_UPLOAD_MESSAGE, {
      name: file.name,
      type: file.type || "(none)",
    });
    return fail("google-docs", GOOGLE_DOCS_UPLOAD_MESSAGE);
  }
  if (file.size > maxUploadBytes()) {
    const message = `Too large. Use a file under ${maxUploadMb()} MB.`;
    reportPickError("book-upload", message, { name: file.name, size: file.size });
    return fail("too-large", message);
  }

  let head: Uint8Array;
  try {
    head = await readFileHead(file, 512 * 1024);
  } catch (error) {
    reportPickError("book-upload", FILE_UNREADABLE_MESSAGE, error);
    return fail("unreadable", describePickReadError());
  }
  if (head.byteLength === 0) {
    reportPickError("book-upload", FILE_UNREADABLE_MESSAGE, {
      name: file.name,
      size: file.size,
    });
    return fail("unreadable", FILE_UNREADABLE_MESSAGE);
  }

  const format = sniffDocumentFormat(head, file.name, file.type);
  if (
    format === "unknown" &&
    !isAcceptableUploadDeclaration(file.name, file.type)
  ) {
    reportPickError("book-upload", UNSUPPORTED_BOOK_MESSAGE, {
      name: file.name,
      type: file.type || "(none)",
    });
    return fail("unsupported", UNSUPPORTED_BOOK_MESSAGE);
  }
  return { ok: true, format };
}

/**
 * Validate a picked clone sample by sniffing audio/video magic bytes.
 * A nameless octet-stream WAV from Drive passes; a text file with a .wav
 * name fails.
 */
export async function validateCloneSamplePick(
  file: File
): Promise<FilePickResult> {
  if (isGoogleAppsDocumentEntry(file.name, file.type)) {
    reportPickError("clone-sample", GOOGLE_DOCS_UPLOAD_MESSAGE, {
      name: file.name,
      type: file.type || "(none)",
    });
    return fail("google-docs", GOOGLE_DOCS_UPLOAD_MESSAGE);
  }
  if (file.size > maxCloneSampleBytes()) {
    const message = `Sample must be ${maxCloneSampleMb()} MB or smaller.`;
    reportPickError("clone-sample", message, { name: file.name, size: file.size });
    return fail("too-large", message);
  }

  let head: Uint8Array<ArrayBuffer>;
  try {
    head = await readFileHead(file, 512 * 1024);
  } catch (error) {
    reportPickError("clone-sample", FILE_UNREADABLE_MESSAGE, error);
    return fail("unreadable", describePickReadError());
  }
  if (head.byteLength === 0) {
    reportPickError("clone-sample", FILE_UNREADABLE_MESSAGE, {
      name: file.name,
      size: file.size,
    });
    return fail("unreadable", FILE_UNREADABLE_MESSAGE);
  }

  const sniffed = sniffCloneSampleFormat(head);
  if (sniffed) return { ok: true, format: sniffed };
  const declaredType = contentTypeForCloneSample(file.name, file.type);
  if (declaredType && !looksLikePlainText(head)) {
    // Name and MIME say audio but the magic bytes are missing; rare
    // container variants still get through, plain text does not.
    return { ok: true, format: "declared" };
  }
  reportPickError("clone-sample", UNSUPPORTED_SAMPLE_MESSAGE, {
    name: file.name,
    type: file.type || "(none)",
  });
  return fail("unsupported", UNSUPPORTED_SAMPLE_MESSAGE);
}
