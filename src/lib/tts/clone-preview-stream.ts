/**
 * Stream a stored clone preview. The body is not buffered first: headers
 * go out once the opening bytes show the object is audio.
 *
 * A full read (`bytes=0-` or no Range) is a 200 the CDN may keep. Any other
 * range is a 206 the CDN must not store: a Safari `bytes=0-1` probe cached
 * as this URL's body would be the clip for a year. Chrome's media element
 * still needs `Cache-Control` to allow a private slice; `no-store` on that
 * header is what makes the element fail. The CDN headers are the no-store.
 */

import { createHash } from "crypto";

import { RangeNotSatisfiableError, singleByteRangeHeader } from "@/lib/storage/byte-range";
import { openStoredBody, readObjectStat } from "@/lib/storage";
import { previewObjectUnusable } from "@/lib/tts/audio-guard";
import { CLONE_PREVIEW_MEDIA_CACHE } from "@/lib/tts/clone-preview-media";

/** Matches `CLONE_PREVIEW_AUDIO_CACHE` / `CLONE_PREVIEW_CDN_CACHE`. Kept here so this module does not import the planner. */
const PRIVATE_AUDIO_CACHE = "private, max-age=31536000, immutable";
const PRIVATE_SLICE_CACHE = "private, max-age=3600";
const CDN_NO_STORE = "no-store";

/** Enough of the start to see ID3, a frame sync, or a zero-filled object. */
const HEADER_PEEK_BYTES = 64;

export type ClonePreviewResolve = "stored" | "token" | "walk";

type HeaderRequest = {
  headers: { get(name: string): string | null };
  signal?: AbortSignal;
};

/** ETag from the object key. Reading the MP3 to hash it would buffer the file. */
export function clonePreviewPathEtag(storagePath: string): string {
  const hash = createHash("sha256").update(storagePath).digest("hex").slice(0, 32);
  return `"${hash}"`;
}

export function clonePreviewServerTiming(
  marks: Record<string, number>
): string {
  return Object.entries(marks)
    .filter(([, dur]) => Number.isFinite(dur) && dur >= 0)
    .map(([name, dur]) => `${name};dur=${dur.toFixed(1)}`)
    .join(", ");
}

function cdnNoStore(headers: Record<string, string>): Record<string, string> {
  return {
    ...headers,
    "CDN-Cache-Control": CDN_NO_STORE,
    "Vercel-CDN-Cache-Control": CDN_NO_STORE,
  };
}

function mediaCacheHeaders(etag: string, partial: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "Cache-Control": partial ? PRIVATE_SLICE_CACHE : CLONE_PREVIEW_MEDIA_CACHE,
    "CDN-Cache-Control": partial ? CDN_NO_STORE : CLONE_PREVIEW_MEDIA_CACHE,
    "Vercel-CDN-Cache-Control": partial ? CDN_NO_STORE : CLONE_PREVIEW_MEDIA_CACHE,
    Vary: "Range",
    ETag: etag,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "X-Accel-Buffering": "no",
  };
  return partial ? cdnNoStore(headers) : headers;
}

function privateCacheHeaders(etag: string, partial: boolean): Record<string, string> {
  return {
    "Cache-Control": partial ? PRIVATE_SLICE_CACHE : PRIVATE_AUDIO_CACHE,
    "CDN-Cache-Control": CDN_NO_STORE,
    "Vercel-CDN-Cache-Control": CDN_NO_STORE,
    Vary: "Range, Cookie",
    ETag: etag,
    "Accept-Ranges": "bytes",
    "X-Accel-Buffering": "no",
  };
}

function cacheHeaders(
  cache: "private" | "public",
  etag: string,
  partial: boolean
): Record<string, string> {
  return cache === "public"
    ? mediaCacheHeaders(etag, partial)
    : privateCacheHeaders(etag, partial);
}

/** `bytes=0-` is the whole object. Any other single range is a slice. */
function isWholeObjectRange(rangeHeader: string | null): boolean {
  if (!rangeHeader) return true;
  const header = singleByteRangeHeader(rangeHeader);
  return !header || header === "bytes=0-";
}

function sliceIncludesFileStart(statusCode: number, contentRange: string | undefined): boolean {
  if (statusCode !== 206 || !contentRange) return true;
  const match = /^bytes\s+(\d+)-/i.exec(contentRange.trim());
  if (!match?.[1]) return true;
  return Number(match[1]) === 0;
}

function concatPrefix(chunks: Uint8Array[], cap: number): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(Math.min(total, cap));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= out.byteLength) break;
    const take = Math.min(chunk.byteLength, out.byteLength - offset);
    out.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return out;
}

/**
 * Read the opening bytes, then hand back a stream of everything that was
 * and will be read. Cancelling the reader drops the storage connection.
 */
async function peekStoredBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<{
  prefix: Uint8Array;
  body: ReadableStream<Uint8Array>;
  cancel: () => void;
}> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  try {
    while (got < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      chunks.push(value);
      got += value.byteLength;
    }
  } catch (err) {
    cancel();
    throw err;
  }
  let pending = 0;
  const replay = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (pending < chunks.length) {
          controller.enqueue(chunks[pending]!);
          pending += 1;
          return;
        }
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          if (value && value.byteLength > 0) {
            controller.enqueue(value);
            return;
          }
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      cancel();
    },
  });
  return { prefix: concatPrefix(chunks, maxBytes), body: replay, cancel };
}

/**
 * 200/206 with an unread remainder, 304 when the browser already has this
 * key, or null when the object is missing or not audio.
 */
export async function clonePreviewStreamResponse(
  request: HeaderRequest,
  storagePath: string,
  options: {
    cache: "private" | "public";
    resolve: ClonePreviewResolve;
    startedAt: number;
  }
): Promise<Response | null> {
  const etag = clonePreviewPathEtag(storagePath);
  const timing = (openMs: number) =>
    clonePreviewServerTiming({
      open: openMs,
      total: performance.now() - options.startedAt,
    });

  const rangeHeader = request.headers.get("range");
  const ifNoneMatch = request.headers.get("if-none-match");
  // `*` means "if a current representation exists". A missing object is 404,
  // so that match is not a 304. A partial range is served: a 304 would hand
  // the element no bytes.
  if (
    isWholeObjectRange(rangeHeader) &&
    ifNoneMatch &&
    ifNoneMatch.split(",").some((part) => part.trim() === etag)
  ) {
    const headers = cdnNoStore(cacheHeaders(options.cache, etag, false));
    headers["Server-Timing"] = timing(0);
    headers["X-Echomancer-Preview"] = "stored";
    headers["X-Echomancer-Preview-Resolve"] = options.resolve;
    return new Response(null, { status: 304, headers });
  }

  const openAt = performance.now();
  let opened;
  try {
    opened = await openStoredBody(storagePath, rangeHeader, request.signal);
  } catch (err) {
    if (err instanceof RangeNotSatisfiableError) {
      let total = err.totalSize;
      if (total == null) {
        try {
          total = (await readObjectStat(storagePath))?.size;
        } catch {
          total = undefined;
        }
      }
      const rangeHeaders: Record<string, string> = {
        "Cache-Control": "private, no-store",
        "CDN-Cache-Control": CDN_NO_STORE,
        "Vercel-CDN-Cache-Control": CDN_NO_STORE,
        "Accept-Ranges": "bytes",
        "Server-Timing": timing(performance.now() - openAt),
      };
      if (total != null) rangeHeaders["Content-Range"] = `bytes */${total}`;
      return new Response(null, { status: 416, headers: rangeHeaders });
    }
    throw err;
  }
  if (!opened) return null;

  const partial = opened.statusCode === 206;
  // A 206 whose Content-Range omitted the object size reports the slice
  // length as the total. A Safari `bytes=0-1` would then look too small
  // and the clip would 404. Stat only in that case.
  let totalSize = opened.totalSize;
  if (partial && opened.totalSize === opened.contentLength) {
    try {
      const stated = (await readObjectStat(storagePath))?.size;
      if (stated != null && stated > opened.totalSize) totalSize = stated;
    } catch {
      // Keep the slice length. An unknown tiny object stays refused.
    }
  }
  let body = opened.body;
  const peekAt = Math.min(HEADER_PEEK_BYTES, opened.contentLength);
  if (peekAt > 0) {
    const peeked = await peekStoredBody(opened.body, peekAt);
    if (
      previewObjectUnusable(
        totalSize,
        peeked.prefix,
        sliceIncludesFileStart(opened.statusCode, opened.contentRange)
      )
    ) {
      peeked.cancel();
      return null;
    }
    body = peeked.body;
  } else if (previewObjectUnusable(totalSize, new Uint8Array(), true)) {
    void opened.body.cancel().catch(() => {});
    return null;
  }

  const headers = cacheHeaders(options.cache, etag, partial);
  headers["X-Echomancer-Preview"] = "stored";
  headers["X-Echomancer-Preview-Resolve"] = options.resolve;
  headers["Content-Type"] = "audio/mpeg";
  headers["Content-Length"] = String(opened.contentLength);
  headers["Server-Timing"] = timing(performance.now() - openAt);
  if (opened.contentRange) headers["Content-Range"] = opened.contentRange;
  console.info(
    `[clone-preview] ${options.cache} ${options.resolve} ${opened.contentLength}B ${partial ? "partial" : "full"} ${headers["Server-Timing"]}`
  );
  return new Response(body, { status: opened.statusCode, headers });
}
