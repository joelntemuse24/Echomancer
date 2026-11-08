/**
 * HTTP byte ranges for audiobook playback.
 *
 * The browser seeks by asking for `Range: bytes=…`. A correct answer is a
 * 206 whose body is only that slice, with `Content-Range` naming the whole
 * object. Suffix ranges (`bytes=-N`) are the last N bytes — used to probe
 * the end of an MP3 — and must not be rewritten as a range from the start.
 */

export const PLAYBACK_CACHE_CONTROL = "private, no-store";

/**
 * How much of an open-ended `Range: bytes=start-` playback may answer.
 *
 * Chrome follows `/api/storage` and asks for `bytes=0-`. R2 then answers
 * `206` with `Content-Range` running to the last byte. A 575 MB book stays
 * on that one response: the element never reaches metadata, and it errors
 * while the body is still arriving (observed at ~15 s and ~3 MB). The same
 * bytes play once that response is already complete in the disk cache.
 * One window is enough of a 128 kbps file to start. The bytes that follow
 * stay on this same URL: a later range that 302s to R2 is a different
 * origin, and Chrome then raises a network error on the element. The player
 * reloads, the clock returns to 0:00, and the listener sees "Couldn't play
 * this part." A missing Xing header is not what stops the start; Chrome
 * reads the duration from the first frames and this total.
 */
export const PLAYBACK_OPEN_RANGE_BYTES = 256 * 1024;

/**
 * A bounded `Range` for an open-ended playback request, or null when the
 * request already names its end (including a suffix probe, `bytes=-N`).
 */
export function openEndedPlaybackWindow(
  rangeHeader: string | null | undefined
): string | null {
  const header = singleByteRangeHeader(rangeHeader);
  if (!header) return null;
  const spec = header.slice("bytes=".length);
  if (spec.startsWith("-")) return null;
  const dash = spec.indexOf("-");
  if (spec.slice(dash + 1) !== "") return null;
  const start = Number.parseInt(spec.slice(0, dash) || "0", 10);
  if (!Number.isFinite(start) || start < 0) return null;
  return `bytes=${start}-${start + PLAYBACK_OPEN_RANGE_BYTES - 1}`;
}

/**
 * The range this origin will actually read for a playback request.
 *
 * Open-ended ranges are capped at one window. A closed range that already
 * fits is kept. A closed range larger than a window is capped too, so one
 * invocation never streams the rest of a multi-hour file. A short suffix
 * (`bytes=-N`) is the tail probe and stays exact; a huge suffix is the last
 * window. Null means the header is not a single byte range.
 *
 * Every non-null result is served here. Redirecting it would change origin
 * under an element that already has bytes from this URL.
 */
export function cappedPlaybackRange(
  rangeHeader: string | null | undefined
): string | null {
  const header = singleByteRangeHeader(rangeHeader);
  if (!header) return null;
  const open = openEndedPlaybackWindow(header);
  if (open) return open;
  const spec = header.slice("bytes=".length);
  if (spec.startsWith("-")) {
    const suffix = Number.parseInt(spec.slice(1), 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    if (suffix <= PLAYBACK_OPEN_RANGE_BYTES) return header;
    return `bytes=-${PLAYBACK_OPEN_RANGE_BYTES}`;
  }
  const dash = spec.indexOf("-");
  const start = Number.parseInt(spec.slice(0, dash) || "0", 10);
  const end = Number.parseInt(spec.slice(dash + 1), 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  if (end - start + 1 <= PLAYBACK_OPEN_RANGE_BYTES) return header;
  return `bytes=${start}-${start + PLAYBACK_OPEN_RANGE_BYTES - 1}`;
}

export class RangeNotSatisfiableError extends Error {
  readonly totalSize?: number;

  constructor(totalSize?: number) {
    super("Range not satisfiable");
    this.name = "RangeNotSatisfiableError";
    this.totalSize = totalSize;
  }
}

export function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "RequestAbortedError")
  );
}

/** One range we can forward to object storage. Multi-ranges are rejected. */
export function singleByteRangeHeader(
  rangeHeader: string | null | undefined
): string | undefined {
  if (!rangeHeader) return undefined;
  const match = /^bytes=(.+)$/i.exec(rangeHeader.trim());
  const spec = match?.[1]?.trim();
  if (!spec) return undefined;
  if (!/^(?:\d+-\d*|\d*-\d+)$/.test(spec)) return undefined;
  if (spec === "-" || spec === "-0") return undefined;
  return `bytes=${spec}`;
}

export type ByteRange = { start: number; end: number };

/**
 * Resolve a single range against a known size.
 * `null` means the header is not a single range (serve the whole object).
 * `"unsatisfiable"` is a 416.
 */
export function parseByteRange(
  rangeHeader: string,
  fileSize: number
): ByteRange | "unsatisfiable" | null {
  const header = singleByteRangeHeader(rangeHeader);
  if (!header || fileSize < 0) return null;
  if (fileSize === 0) return "unsatisfiable";

  const spec = header.slice("bytes=".length);
  if (spec.startsWith("-")) {
    const suffix = Number.parseInt(spec.slice(1), 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return "unsatisfiable";
    const start = Math.max(0, fileSize - suffix);
    return { start, end: fileSize - 1 };
  }

  const dash = spec.indexOf("-");
  const startRaw = spec.slice(0, dash);
  const endRaw = spec.slice(dash + 1);
  const start = startRaw ? Number.parseInt(startRaw, 10) : 0;
  let end = endRaw ? Number.parseInt(endRaw, 10) : fileSize - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start >= fileSize || start > end) return "unsatisfiable";
  if (end >= fileSize) end = fileSize - 1;
  return { start, end };
}

export function playbackHeaders(options: {
  contentType: string;
  contentLength: number;
  contentRange?: string;
  contentDisposition?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": options.contentType,
    "Content-Length": String(options.contentLength),
    "Accept-Ranges": "bytes",
    // Private and uncached so a later visitor on the same browser cannot
    // replay someone else's bytes from the HTTP cache. Vary on Range so a
    // cache that does keep the response cannot hand the first window back
    // for a later slice of the same URL.
    "Cache-Control": PLAYBACK_CACHE_CONTROL,
    Vary: "Range",
    "X-Accel-Buffering": "no",
  };
  if (options.contentRange) headers["Content-Range"] = options.contentRange;
  if (options.contentDisposition) {
    headers["Content-Disposition"] = options.contentDisposition;
    // Stop Safari from sniffing audio/mpeg and playing the file inline.
    headers["X-Content-Type-Options"] = "nosniff";
  }
  return headers;
}
