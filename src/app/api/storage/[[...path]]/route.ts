import { NextRequest, NextResponse } from "next/server";
import { fileExists, getFullPath, getFileMetadata } from "@/lib/storage";
import { isR2Configured, getFile as r2GetFile } from "@/lib/r2-storage";
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
 */

// Playback issues many range requests per section, so the ceiling is generous;
// it fails open because a database blip should not silence someone's audiobook.
const storageRateLimit = createRateLimiter(600, 60_000, { onError: "open" });

function parseRange(
  rangeHeader: string,
  fileSize: number
): { start: number; end: number } | null {
  const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
  if (!match) return null;

  const start = match[1] ? parseInt(match[1], 10) : 0;
  let end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  if (start >= fileSize) return null;
  if (end >= fileSize) end = fileSize - 1;
  if (start > end) return null;

  return { start, end };
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
    const range = parseRange(rangeHeader, buffer.length);
    if (range) {
      const sliced = buffer.subarray(range.start, range.end + 1);
      const headers: Record<string, string> = {
        "Content-Type": contentType,
        "Content-Length": sliced.length.toString(),
        "Content-Range": `bytes ${range.start}-${range.end}/${buffer.length}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
      };
      if (contentDisposition) headers["Content-Disposition"] = contentDisposition;
      return new NextResponse(new Uint8Array(sliced), { status: 206, headers });
    }
  }

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Length": buffer.length.toString(),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
  };
  if (contentDisposition) headers["Content-Disposition"] = contentDisposition;
  return new NextResponse(new Uint8Array(buffer), { headers });
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
        const raw = await r2GetFile(storagePath);
        const { buffer, contentType } = prepareAudioBuffer(storagePath, raw);
        return audioResponse(buffer, contentType, rangeHeader, contentDisposition);
      } catch (r2Err: unknown) {
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
      return audioResponse(buffer, contentType, rangeHeader, contentDisposition);
    }

    let contentType = mime.lookup(storagePath) || "application/octet-stream";
    if (storagePath.endsWith(".wav")) contentType = "audio/wav";
    if (storagePath.endsWith(".mp3")) contentType = "audio/mpeg";
    if (storagePath.endsWith(".ogg")) contentType = "audio/ogg";

    if (rangeHeader) {
      const range = parseRange(rangeHeader, metadata.size);
      if (range) {
        const stream = createReadStream(fullPath, {
          start: range.start,
          end: range.end,
        });
        const headers: Record<string, string> = {
          "Content-Type": contentType,
          "Content-Length": String(range.end - range.start + 1),
          "Content-Range": `bytes ${range.start}-${range.end}/${metadata.size}`,
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, no-store",
        };
        if (contentDisposition) headers["Content-Disposition"] = contentDisposition;
        return new NextResponse(stream as unknown as BodyInit, {
          status: 206,
          headers,
        });
      }
    }

    const stream = createReadStream(fullPath);
    const localHeaders: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Length": metadata.size.toString(),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
    };
    if (contentDisposition) localHeaders["Content-Disposition"] = contentDisposition;
    return new NextResponse(stream as unknown as BodyInit, {
      headers: localHeaders,
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
