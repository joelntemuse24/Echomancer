import { NextRequest, NextResponse } from "next/server";
import { fileExists } from "@/lib/storage";
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
 * A ready `full.*` artifact redirects to the storage proxy, which streams
 * the object. Buffering it in this function (then again as a browser blob)
 * is what left mobile taps sitting on "Preparing…". The fallback still
 * concatenates ready sections into a buffer with an explicit `Content-Length`:
 * streaming a length-less body made browsers truncate the download after
 * roughly one section.
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

    if (
      audioStoragePath &&
      !isSectionStoragePath(audioStoragePath) &&
      (await fileExists(audioStoragePath))
    ) {
      const ext =
        audioStoragePath.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || "mp3";
      const target = new URL(`/api/storage/${audioStoragePath}`, request.url);
      target.searchParams.set("download", `${safeTitle}.${ext}`);
      const redirect = NextResponse.redirect(target, 307);
      redirect.headers.set("Cache-Control", "private, no-store");
      return redirect;
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
      headers: {
        // octet-stream so iOS saves the file instead of playing it inline.
        "Content-Type": "application/octet-stream",
        "Content-Length": String(built.buffer.length),
        "Content-Disposition": `attachment; filename="${safeTitle}.${built.format.extension}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Echomancer-Sections": String(
          segments.filter((s) => s.status === "ready").length
        ),
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
