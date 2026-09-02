import { NextRequest, NextResponse } from "next/server";
import { downloadFile } from "@/lib/storage";
import { execute } from "@/lib/turso";
import { handleApiError } from "@/lib/errors";
import { requireOwnedJob } from "@/lib/auth/guard";
import type { JobSegment } from "@/lib/tts/types";
import {
  concatReadySegments,
  isSectionStoragePath,
  materializeFullAudiobook,
} from "@/lib/tts/concat-audio";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Download the whole audiobook as one file.
 *
 * Prefers the pre-built `full.*` artifact. The fallback concatenates ready
 * sections into a buffer with an explicit `Content-Length`: streaming a
 * length-less body made browsers truncate the download after roughly one
 * section.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { job } = await requireOwnedJob(request, id);

    const safeTitle = String(job.book_title || "audiobook")
      .replace(/[^a-z0-9]+/gi, "_")
      .toLowerCase();
    const audioStoragePath =
      typeof job.audio_storage_path === "string" ? job.audio_storage_path : null;

    if (audioStoragePath && !isSectionStoragePath(audioStoragePath)) {
      try {
        const buf = await downloadFile(audioStoragePath);
        const ext =
          audioStoragePath.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || "mp3";
        return new NextResponse(new Uint8Array(buf), {
          headers: {
            "Content-Type": contentTypeForExtension(ext),
            "Content-Length": String(buf.length),
            "Content-Disposition": `attachment; filename="${safeTitle}.${ext}"`,
            "Cache-Control": "private, no-store",
            "X-Echomancer-Sections": "prebuilt",
          },
        });
      } catch (err) {
        console.warn(
          `[Download ${id}] prebuilt file missing, falling back to concat:`,
          err
        );
      }
    }

    let segments: JobSegment[] = [];
    if (typeof job.segments_json === "string" && job.segments_json) {
      try {
        segments = JSON.parse(job.segments_json) as JobSegment[];
      } catch {
        segments = [];
      }
    }

    const total =
      typeof job.total_sections === "number" ? job.total_sections : segments.length;
    const built = await concatReadySegments(segments, `[Download ${id}]`, {
      total,
      requireAllIndexes: job.status === "ready" || total > 0,
    });
    if (!built) {
      return NextResponse.json(
        { error: "No audio segments available" },
        { status: 404 }
      );
    }

    // A finished job that still points at section 0 predates the full-file
    // artifact; build it once so later downloads take the fast path.
    if (job.status === "ready" && isSectionStoragePath(audioStoragePath)) {
      void materializeFullAudiobook(id, segments)
        .then(async (path) => {
          if (!path) return;
          await execute(
            `UPDATE jobs SET audio_storage_path = ?, updated_at = unixepoch() WHERE id = ?`,
            [path, id]
          );
        })
        .catch((err) =>
          console.warn(`[Download ${id}] backfill failed:`, err)
        );
    }

    return new NextResponse(new Uint8Array(built.buffer), {
      headers: {
        "Content-Type": built.format.contentType,
        "Content-Length": String(built.buffer.length),
        "Content-Disposition": `attachment; filename="${safeTitle}.${built.format.extension}"`,
        "Cache-Control": "private, no-store",
        "X-Echomancer-Sections": String(
          segments.filter((s) => s.status === "ready").length
        ),
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

function contentTypeForExtension(ext: string): string {
  if (ext === "wav") return "audio/wav";
  if (ext === "ogg") return "audio/ogg";
  return "audio/mpeg";
}
