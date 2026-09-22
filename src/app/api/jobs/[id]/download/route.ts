import { NextRequest, NextResponse } from "next/server";
import { openDownloadBody } from "@/lib/storage";
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
 * A ready `full.*` artifact is streamed back as `Content-Disposition:
 * attachment`. Desktop Chrome, Edge, and Firefox drop the download when this
 * URL 307s somewhere else, so the response is 200 from this route. The
 * fallback still concatenates ready sections into a buffer with an explicit
 * `Content-Length`: streaming a length-less body made browsers truncate the
 * download after roughly one section.
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
        const opened = await openDownloadBody(audioStoragePath, request.signal);
        if (opened) {
          const ext =
            audioStoragePath.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ||
            "mp3";
          return new NextResponse(opened.body, {
            headers: attachmentHeaders(
              `${safeTitle}.${ext}`,
              opened.contentLength,
              "prebuilt"
            ),
          });
        }
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
    let crossfadeMs: number | undefined;
    if (typeof job.tts_options === "string" && job.tts_options) {
      try {
        const options = JSON.parse(job.tts_options) as { crossfadeMs?: unknown };
        if (typeof options.crossfadeMs === "number") {
          crossfadeMs = options.crossfadeMs;
        }
      } catch {
        /* keep default join */
      }
    }
    const built = await concatReadySegments(segments, `[Download ${id}]`, {
      total,
      requireAllIndexes: job.status === "ready" || total > 0,
      crossfadeMs,
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
      headers: attachmentHeaders(
        `${safeTitle}.${built.format.extension}`,
        built.buffer.length,
        String(segments.filter((s) => s.status === "ready").length)
      ),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/** Direct attachment. A redirect makes desktop browsers navigate instead of save. */
function attachmentHeaders(
  filename: string,
  contentLength: number,
  sections: string
): Record<string, string> {
  return {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(contentLength),
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Echomancer-Sections": sections,
  };
}
