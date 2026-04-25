import { NextRequest, NextResponse } from "next/server";
import { downloadFileStream, fileExists, getFullPath, getFileMetadata } from "@/lib/storage";
import { createReadStream } from "fs";
import path from "path";
import mime from "mime-types";

// Force dynamic for file serving
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
    const fullPath = getFullPath(storagePath);

    // Security check: ensure path is within storage root
    const storageRoot = path.resolve(process.env.STORAGE_PATH || "./data/storage");
    const resolvedPath = path.resolve(fullPath);
    if (!resolvedPath.startsWith(storageRoot)) {
      return NextResponse.json({ error: "Invalid path" }, { status: 403 });
    }

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

    // Create read stream
    const stream = createReadStream(fullPath);

    // Return file as stream
    return new NextResponse(stream as any, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": metadata.size.toString(),
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (error) {
    console.error("[Storage API] Error serving file:", error);
    return NextResponse.json(
      { error: "Failed to serve file" },
      { status: 500 }
    );
  }
}
