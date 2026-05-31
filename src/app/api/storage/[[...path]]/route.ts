import { NextRequest, NextResponse } from "next/server";
import { downloadFile, fileExists, getFileMetadata } from "@/lib/storage";
import { isR2Configured } from "@/lib/r2-storage";
import path from "path";
import mime from "mime-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

    if (storagePath.includes("..")) {
      return NextResponse.json({ error: "Invalid path" }, { status: 403 });
    }

    if (!isR2Configured()) {
      const { getFullPath } = await import("@/lib/storage");
      const fullPath = getFullPath(storagePath);
      const storagePathEnv = process.env.STORAGE_PATH || (process.env.VERCEL ? "/tmp" : "./data/storage");
      const storageRoot = path.resolve(storagePathEnv) + path.sep;
      const resolvedPath = path.resolve(fullPath) + path.sep;
      if (!resolvedPath.startsWith(storageRoot)) {
        console.error(`[Storage API] Path traversal blocked: resolved=${resolvedPath}, root=${storageRoot}`);
        return NextResponse.json({ error: "Invalid path" }, { status: 403 });
      }
    }

    if (!(await fileExists(storagePath))) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const metadata = await getFileMetadata(storagePath);
    if (!metadata) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const contentType = mime.lookup(storagePath) || "application/octet-stream";

    const buffer = await downloadFile(storagePath);

    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Length": metadata.size.toString(),
      "Cache-Control": "public, max-age=3600",
    };

    const downloadName = request.nextUrl.searchParams.get("download");
    if (downloadName) {
      headers["Content-Disposition"] = `attachment; filename="${downloadName}"`;
    }

    return new NextResponse(new Uint8Array(buffer), { headers });
  } catch (error) {
    console.error("[Storage API] Error serving file:", error);
    return NextResponse.json(
      { error: "Failed to serve file" },
      { status: 500 }
    );
  }
}
