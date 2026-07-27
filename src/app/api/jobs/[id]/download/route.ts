import { NextRequest, NextResponse } from "next/server";
import { getJob } from "@/lib/turso/jobs";
import { downloadFile } from "@/lib/storage";
import { execute } from "@/lib/turso";
import type { JobSegment } from "@/lib/tts/types";
import {
  concatReadySegments,
  isSectionStoragePath,
  materializeFullAudiobook,
} from "@/lib/tts/concat-audio";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Download full audiobook as one file.
 * Prefers a pre-built full.* artifact; otherwise concatenates ready sections
 * into a single buffer with Content-Length (streaming without length often
 * truncates in browsers to ~one section).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const job = await getJob(id);

    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const row = job as typeof job & Record<string, unknown>;
    const safeTitle = (job.book_title || "audiobook")
      .replace(/[^a-z0-9]+/gi, "_")
      .toLowerCase();

    // Prefer pre-built full book (not a single /sections/N path)
    if (
      job.audio_storage_path &&
      !isSectionStoragePath(job.audio_storage_path)
    ) {
      try {
        const buf = await downloadFile(job.audio_storage_path);
        const ext =
          job.audio_storage_path.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ||
          "mp3";
        const contentType =
          ext === "wav"
            ? "audio/wav"
            : ext === "ogg"
              ? "audio/ogg"
              : "audio/mpeg";
        return new NextResponse(new Uint8Array(buf), {
          headers: {
            "Content-Type": contentType,
            "Content-Length": String(buf.length),
            "Content-Disposition": `attachment; filename="${safeTitle}.${ext}"`,
            "Cache-Control": "private",
            "X-Echomancer-Sections": "prebuilt",
          },
        });
      } catch (err) {
        console.warn(
          `[Download ${id}] prebuilt full file missing, falling back to concat:`,
          err
        );
      }
    }

    let segments: JobSegment[] = [];
    if (typeof row.segments_json === "string" && row.segments_json) {
      try {
        segments = JSON.parse(row.segments_json as string) as JobSegment[];
      } catch {
        segments = [];
      }
    }

    const built = await concatReadySegments(segments, `[Download ${id}]`);
    if (!built) {
      return NextResponse.json(
        { error: "No audio segments available" },
        { status: 404 }
      );
    }

    // Backfill full.* for ready jobs that still point at section 0
    if (job.status === "ready" && isSectionStoragePath(job.audio_storage_path)) {
      void materializeFullAudiobook(id, segments)
        .then(async (path) => {
          if (!path) return;
          await execute(
            `UPDATE jobs SET audio_storage_path = ?, updated_at = unixepoch() WHERE id = ?`,
            [path, id]
          );
        })
        .catch((err) =>
          console.warn(`[Download ${id}] backfill full audiobook failed:`, err)
        );
    }

    const filename = `${safeTitle}.${built.format.extension}`;
    const readyCount = segments.filter((s) => s.status === "ready").length;

    return new NextResponse(new Uint8Array(built.buffer), {
      headers: {
        "Content-Type": built.format.contentType,
        "Content-Length": String(built.buffer.length),
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private",
        "X-Echomancer-Sections": String(readyCount),
      },
    });
  } catch (error) {
    console.error("Download error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
