import { NextRequest, NextResponse } from "next/server";
import { downloadFileStream, fileExists, getFullPath, getFileMetadata } from "@/lib/storage";
import { isR2Configured, getFile as r2GetFile } from "@/lib/r2-storage";
import { createReadStream } from "fs";
import path from "path";
import mime from "mime-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Parse a Range header value.
 * Supports formats like "bytes=0-1023" or "bytes=1024-".
 * Returns { start, end } or null if invalid.
 */
function parseRange(rangeHeader: string, fileSize: number): { start: number; end: number } | null {
  const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
  if (!match) return null;

  let start = match[1] ? parseInt(match[1], 10) : 0;
  let end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  if (start >= fileSize) return null;
  if (end >= fileSize) end = fileSize - 1;
  if (start > end) return null;

  return { start, end };
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
    const rangeHeader = request.headers.get("range");

    // Check if file exists
    if (!(await fileExists(storagePath))) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    // Get file metadata
    const metadata = await getFileMetadata(storagePath);
    if (!metadata) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    // Determine content type
    const contentType = mime.lookup(storagePath) || "application/octet-stream";

    // Support download query param
    const downloadName = request.nextUrl.searchParams.get("download");
    const contentDisposition = downloadName
      ? `attachment; filename="${downloadName}"`
      : undefined;

    // ── R2 path ───────────────────────────────────────────────
    if (isR2Configured()) {
      try {
        const buffer = await r2GetFile(storagePath);

        if (rangeHeader) {
          const range = parseRange(rangeHeader, buffer.length);
          if (range) {
            const sliced = buffer.subarray(range.start, range.end + 1);
            const headers: Record<string, string> = {
              "Content-Type": contentType,
              "Content-Length": sliced.length.toString(),
              "Content-Range": `bytes ${range.start}-${range.end}/${buffer.length}`,
              "Accept-Ranges": "bytes",
              "Cache-Control": "public, max-age=3600",
            };
            if (contentDisposition) headers["Content-Disposition"] = contentDisposition;
            return new NextResponse(new Uint8Array(sliced), { status: 206, headers });
          }
        }

        const headers: Record<string, string> = {
          "Content-Type": contentType,
          "Content-Length": buffer.length.toString(),
          "Accept-Ranges": "bytes",
          "Cache-Control": "public, max-age=3600",
        };
        if (contentDisposition) headers["Content-Disposition"] = contentDisposition;

        return new NextResponse(new Uint8Array(buffer), { headers });
      } catch (r2Err: any) {
        console.error(`[Storage API] R2 fetch failed for ${storagePath}:`, r2Err?.message);
        return NextResponse.json({ error: "Failed to fetch file from storage" }, { status: 500 });
      }
    }

    // ── Local filesystem fallback ─────────────────────────────
    const fullPath = getFullPath(storagePath);

    // Security check: ensure path is within storage root
    const storagePathEnv = process.env.STORAGE_PATH || (process.env.VERCEL ? "/tmp" : "./data/storage");
    const storageRoot = path.resolve(storagePathEnv) + path.sep;
    const resolvedPath = path.resolve(fullPath) + path.sep;
    if (!resolvedPath.startsWith(storageRoot)) {
      console.error(`[Storage API] Path traversal blocked: resolved=${resolvedPath}, root=${storageRoot}`);
      return NextResponse.json({ error: "Invalid path" }, { status: 403 });
    }

    if (rangeHeader) {
      const range = parseRange(rangeHeader, metadata.size);
      if (range) {
        const stream = createReadStream(fullPath, { start: range.start, end: range.end });
        const headers: Record<string, string> = {
          "Content-Type": contentType,
          "Content-Length": String(range.end - range.start + 1),
          "Content-Range": `bytes ${range.start}-${range.end}/${metadata.size}`,
          "Accept-Ranges": "bytes",
          "Cache-Control": "public, max-age=3600",
        };
        if (contentDisposition) headers["Content-Disposition"] = contentDisposition;
        return new NextResponse(stream as any, { status: 206, headers });
      }
    }

    const stream = createReadStream(fullPath);

    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Length": metadata.size.toString(),
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
    };

    if (contentDisposition) headers["Content-Disposition"] = contentDisposition;

    return new NextResponse(stream as any, { headers });
  } catch (error) {
    console.error("[Storage API] Error serving file:", error);
    return NextResponse.json(
      { error: "Failed to serve file" },
      { status: 500 }
    );
  }
}
