/**
 * HTTP byte ranges for audiobook playback.
 *
 * The browser seeks by asking for `Range: bytes=…`. A correct answer is a
 * 206 whose body is only that slice, with `Content-Range` naming the whole
 * object. Suffix ranges (`bytes=-N`) are the last N bytes — used to probe
 * the end of an MP3 — and must not be rewritten as a range from the start.
 */

export const PLAYBACK_CACHE_CONTROL = "private, no-store";

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
    // replay someone else's bytes from the HTTP cache. The media element's
    // own buffer still covers short skips inside already-fetched audio.
    "Cache-Control": PLAYBACK_CACHE_CONTROL,
    "X-Accel-Buffering": "no",
  };
  if (options.contentRange) headers["Content-Range"] = options.contentRange;
  if (options.contentDisposition) {
    headers["Content-Disposition"] = options.contentDisposition;
  }
  return headers;
}
