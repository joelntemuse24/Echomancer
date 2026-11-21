/**
 * Stream a stored clone preview. The body is not buffered first: headers
 * go out once object storage has named the length.
 */

import { createHash } from "crypto";

import { RangeNotSatisfiableError } from "@/lib/storage/byte-range";
import { openStoredBody } from "@/lib/storage";
import { MIN_AUDIBLE_BYTES } from "@/lib/tts/audio-guard";
import { CLONE_PREVIEW_MEDIA_CACHE } from "@/lib/tts/clone-preview-media";

/** Matches `CLONE_PREVIEW_AUDIO_CACHE` / `CLONE_PREVIEW_CDN_CACHE`. Kept here so this module does not import the planner. */
const PRIVATE_AUDIO_CACHE = "private, max-age=31536000, immutable";
const CDN_NO_STORE = "no-store";

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

function mediaCacheHeaders(etag: string): Record<string, string> {
  return {
    "Cache-Control": CLONE_PREVIEW_MEDIA_CACHE,
    "CDN-Cache-Control": CLONE_PREVIEW_MEDIA_CACHE,
    "Vercel-CDN-Cache-Control": CLONE_PREVIEW_MEDIA_CACHE,
    ETag: etag,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "X-Accel-Buffering": "no",
  };
}

function privateCacheHeaders(etag: string): Record<string, string> {
  return {
    "Cache-Control": PRIVATE_AUDIO_CACHE,
    "CDN-Cache-Control": CDN_NO_STORE,
    "Vercel-CDN-Cache-Control": CDN_NO_STORE,
    Vary: "Cookie",
    ETag: etag,
    "Accept-Ranges": "bytes",
    "X-Accel-Buffering": "no",
  };
}

function cacheHeaders(
  cache: "private" | "public",
  etag: string
): Record<string, string> {
  return cache === "public" ? mediaCacheHeaders(etag) : privateCacheHeaders(etag);
}

/**
 * 200/206 with an unread body, 304 when the browser already has this key,
 * or null when the object is missing or too small to be audio.
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
  const headers = cacheHeaders(options.cache, etag);
  headers["X-Echomancer-Preview"] = "stored";
  headers["X-Echomancer-Preview-Resolve"] = options.resolve;
  const timing = (openMs: number) =>
    clonePreviewServerTiming({
      open: openMs,
      total: performance.now() - options.startedAt,
    });

  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch.split(",").some((part) => {
    const token = part.trim();
    return token === "*" || token === etag;
  })) {
    headers["Server-Timing"] = timing(0);
    return new Response(null, { status: 304, headers });
  }

  const openAt = performance.now();
  let opened;
  try {
    opened = await openStoredBody(
      storagePath,
      request.headers.get("range"),
      request.signal
    );
  } catch (err) {
    if (err instanceof RangeNotSatisfiableError) {
      const rangeHeaders: Record<string, string> = {
        "Cache-Control": "private, no-store",
        "CDN-Cache-Control": CDN_NO_STORE,
        "Vercel-CDN-Cache-Control": CDN_NO_STORE,
        "Server-Timing": timing(performance.now() - openAt),
      };
      if (err.totalSize != null) {
        rangeHeaders["Content-Range"] = `bytes */${err.totalSize}`;
      }
      return new Response(null, { status: 416, headers: rangeHeaders });
    }
    throw err;
  }
  if (!opened || opened.totalSize < MIN_AUDIBLE_BYTES) {
    if (opened) void opened.body.cancel().catch(() => {});
    return null;
  }

  headers["Content-Type"] = "audio/mpeg";
  headers["Content-Length"] = String(opened.contentLength);
  headers["Server-Timing"] = timing(performance.now() - openAt);
  if (opened.contentRange) headers["Content-Range"] = opened.contentRange;
  console.info(
    `[clone-preview] ${options.cache} ${options.resolve} ${opened.contentLength}B ${headers["Server-Timing"]}`
  );
  return new Response(opened.body, { status: opened.statusCode, headers });
}
