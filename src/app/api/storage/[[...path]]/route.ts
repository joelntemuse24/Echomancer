import { NextRequest, NextResponse } from "next/server";
import { fileExists, getFullPath, getFileMetadata } from "@/lib/storage";
import { isR2Configured, getFile as r2GetFile, openObject } from "@/lib/r2-storage";
import { createReadStream } from "fs";
import { readFile } from "fs/promises";
import path from "path";
import mime from "mime-types";
import { pcmToWav } from "@/lib/tts/pcm-wav";
import { resolveSessionUserId } from "@/lib/auth/session";
import { ownsStoragePath } from "@/lib/auth/guard";
import {
  clientIp,
  createRateLimiter,
  rateLimitIdentity,
} from "@/lib/rate-limit";
import {
  PLAYBACK_CACHE_CONTROL,
  RangeNotSatisfiableError,
  isAbortError,
  parseByteRange,
  playbackHeaders,
} from "@/lib/storage/byte-range";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A playing book may hold one progressive response open. Seeks are short
// ranges; this only keeps a long read from dying at the platform default.
export const maxDuration = 300;

/**
 * Read proxy for generated audio and uploaded text.
 *
 * Object keys are guessable (`audiobooks/<jobId>/sections/0000.mp3`), so the key
 * is not a secret and cannot be the only thing standing between one visitor's
 * book and another's. Every request is resolved back to the owning job or upload
 * and matched against the caller's session.
 *
 * The player fetches these URLs from the same origin, so the session cookie
 * rides along on `<audio src>` and range requests without any extra plumbing.
 *
 * R2 seeks must stream the requested range. Downloading the whole `full.mp3`
 * before answering made every skip wait on a 40–70 MB fetch.
 */

// Playback issues many range requests per section, so the ceiling is generous;
// it fails open because a database blip should not silence someone's audiobook.
const storageRateLimit = createRateLimiter(600, 60_000, { onError: "open" });

function contentTypeForPath(storagePath: string, fallback?: string): string {
  if (storagePath.endsWith(".wav")) return "audio/wav";
  if (storagePath.endsWith(".mp3")) return "audio/mpeg";
  if (storagePath.endsWith(".ogg")) return "audio/ogg";
  const lookedUp = mime.lookup(storagePath);
  return lookedUp || fallback || "application/octet-stream";
}

/**
 * A named download must not be `audio/*`. iOS Safari plays those inline and
 * never offers Save, even when Content-Disposition says attachment.
 */
function contentTypeForDelivery(
  storagePath: string,
  fallback: string | undefined,
  asDownload: boolean
): string {
  if (asDownload) return "application/octet-stream";
  return contentTypeForPath(storagePath, fallback);
}

function rangeNotSatisfiable(totalSize?: number): NextResponse {
  return new NextResponse(null, {
    status: 416,
    headers: {
      "Content-Range":
        totalSize != null ? `bytes */${totalSize}` : "bytes */*",
      "Accept-Ranges": "bytes",
      "Cache-Control": PLAYBACK_CACHE_CONTROL,
    },
  });
}

function prepareAudioBuffer(
  storagePath: string,
  buffer: Buffer
): { buffer: Buffer; contentType: string } {
  let contentType = mime.lookup(storagePath) || "application/octet-stream";
  if (storagePath.endsWith(".pcm")) {
    // Raw PCM sections need a WAV wrapper before a browser will play them.
    return { buffer: pcmToWav(buffer), contentType: "audio/wav" };
  }
  if (storagePath.endsWith(".wav")) contentType = "audio/wav";
  if (storagePath.endsWith(".mp3")) contentType = "audio/mpeg";
  if (storagePath.endsWith(".ogg")) contentType = "audio/ogg";
  return { buffer, contentType };
}

function audioResponse(
  buffer: Buffer,
  contentType: string,
  rangeHeader: string | null,
  contentDisposition?: string
): NextResponse {
  if (rangeHeader) {
    const range = parseByteRange(rangeHeader, buffer.length);
    if (range === "unsatisfiable") return rangeNotSatisfiable(buffer.length);
    if (range) {
      const sliced = buffer.subarray(range.start, range.end + 1);
      return new NextResponse(new Uint8Array(sliced), {
        status: 206,
        headers: playbackHeaders({
          contentType,
          contentLength: sliced.length,
          contentRange: `bytes ${range.start}-${range.end}/${buffer.length}`,
          contentDisposition,
        }),
      });
    }
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: playbackHeaders({
      contentType,
      contentLength: buffer.length,
      contentDisposition,
    }),
  });
}

function notFound(): NextResponse {
  // Same answer for "missing" and "not yours" so the proxy cannot be used to
  // probe which job ids exist.
  return NextResponse.json({ error: "File not found" }, { status: 404 });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> }
) {
  try {
    const { path: pathSegments } = await params;

    if (!pathSegments || pathSegments.length === 0) {
      return NextResponse.json({ error: "No path specified" }, { status: 400 });
    }

    const storagePath = pathSegments.join("/");

    if (
      pathSegments.some(
        (seg) => !seg || seg === "." || seg === ".." || seg.includes("\0")
      ) ||
      storagePath.includes("..") ||
      storagePath.startsWith("/")
    ) {
      console.error(`[Storage API] Path traversal blocked: ${storagePath}`);
      return NextResponse.json({ error: "Invalid path" }, { status: 403 });
    }

    const userId = await resolveSessionUserId(request);
    if (!userId) return notFound();

    if (!(await storageRateLimit(
      await rateLimitIdentity({
        userId,
        ip: clientIp(request),
      })
    ))) {
      return NextResponse.json(
        { error: "Too many requests. Please slow down." },
        { status: 429 }
      );
    }

    if (!(await ownsStoragePath(userId, storagePath))) {
      console.warn(
        `[Storage API] denied ${storagePath} for ${userId}`
      );
      return notFound();
    }

    const rangeHeader = request.headers.get("range");
    const downloadName = request.nextUrl.searchParams.get("download");
    const contentDisposition = downloadName
      ? `attachment; filename="${sanitizeFilename(downloadName)}"`
      : undefined;

    if (isR2Configured()) {
      try {
        // Raw PCM is wrapped as WAV, which shifts every byte offset. Those
        // section files are small; MP3/WAV/Ogg books stream the range as-is.
        if (storagePath.endsWith(".pcm")) {
          const raw = await r2GetFile(storagePath);
          const { buffer, contentType } = prepareAudioBuffer(storagePath, raw);
          return audioResponse(buffer, contentType, rangeHeader, contentDisposition);
        }

        const opened = await openObject(storagePath, rangeHeader, {
          signal: request.signal,
        });
        return new Response(opened.body, {
          status: opened.statusCode,
          headers: playbackHeaders({
            contentType: contentTypeForDelivery(
              storagePath,
              opened.contentType,
              Boolean(downloadName)
            ),
            contentLength: opened.contentLength,
            contentRange: opened.contentRange,
            contentDisposition,
          }),
        });
      } catch (r2Err: unknown) {
        if (r2Err instanceof RangeNotSatisfiableError) {
          return rangeNotSatisfiable(r2Err.totalSize);
        }
        if (isAbortError(r2Err)) {
          return new Response(null, { status: 499 });
        }
        console.error(
          `[Storage API] R2 fetch failed for ${storagePath}:`,
          r2Err instanceof Error ? r2Err.message : r2Err
        );
        return notFound();
      }
    }

    // ── Local filesystem (dev only, when R2 is not configured) ───
    if (!(await fileExists(storagePath))) return notFound();

    const metadata = await getFileMetadata(storagePath);
    if (!metadata) return notFound();

    const fullPath = getFullPath(storagePath);
    const storagePathEnv =
      process.env.STORAGE_PATH || (process.env.VERCEL ? "/tmp" : "./data/storage");
    const storageRoot = path.resolve(storagePathEnv) + path.sep;
    const resolvedPath = path.resolve(fullPath) + path.sep;
    if (!resolvedPath.startsWith(storageRoot)) {
      console.error(
        `[Storage API] Path traversal blocked: resolved=${resolvedPath}, root=${storageRoot}`
      );
      return NextResponse.json({ error: "Invalid path" }, { status: 403 });
    }

    if (storagePath.endsWith(".pcm")) {
      const raw = await readFile(fullPath);
      const { buffer, contentType } = prepareAudioBuffer(storagePath, raw);
      return audioResponse(
        buffer,
        downloadName ? "application/octet-stream" : contentType,
        rangeHeader,
        contentDisposition
      );
    }

    const contentType = contentTypeForDelivery(
      storagePath,
      undefined,
      Boolean(downloadName)
    );

    if (rangeHeader) {
      const range = parseByteRange(rangeHeader, metadata.size);
      if (range === "unsatisfiable") return rangeNotSatisfiable(metadata.size);
      if (range) {
        const stream = createReadStream(fullPath, {
          start: range.start,
          end: range.end,
        });
        return new NextResponse(stream as unknown as BodyInit, {
          status: 206,
          headers: playbackHeaders({
            contentType,
            contentLength: range.end - range.start + 1,
            contentRange: `bytes ${range.start}-${range.end}/${metadata.size}`,
            contentDisposition,
          }),
        });
      }
    }

    const stream = createReadStream(fullPath);
    return new NextResponse(stream as unknown as BodyInit, {
      headers: playbackHeaders({
        contentType,
        contentLength: metadata.size,
        contentDisposition,
      }),
    });
  } catch (error) {
    console.error("[Storage API] Error serving file:", error);
    return NextResponse.json({ error: "Failed to serve file" }, { status: 500 });
  }
}

/** Keep a caller-supplied download name out of the header grammar. */
function sanitizeFilename(name: string): string {
  return name.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "audiobook";
}
