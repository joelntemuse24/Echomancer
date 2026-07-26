import { NextRequest, NextResponse } from "next/server";
import { getJob, deleteJob, resetJob } from "@/lib/turso/jobs";
import { deleteFile, fileExists, listFiles } from "@/lib/storage";
import type { JobSegment } from "@/lib/tts/types";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const job = await getJob(id);

    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const row = job as typeof job & Record<string, unknown>;
    let segments = null;
    if (typeof row.segments_json === "string" && row.segments_json) {
      try {
        segments = JSON.parse(row.segments_json as string);
      } catch {
        segments = null;
      }
    }

    // H9: Exclude internal storage paths from public response
    const formattedJob = {
      id: job.id,
      book_title: job.book_title,
      voice_name: job.voice_name,
      status: job.status,
      progress: job.progress,
      current_section: job.current_section,
      total_sections: job.total_sections,
      duration_seconds: job.duration_seconds,
      error_message: job.error_message,
      generation_mode: row.generation_mode ?? "stock",
      job_kind: row.job_kind ?? "takehome",
      tts_provider: row.tts_provider ?? null,
      provider_voice_id: row.provider_voice_id ?? null,
      catalog_voice_id: row.catalog_voice_id ?? null,
      char_count: row.char_count ?? 0,
      stream_cursor: row.stream_cursor ?? 0,
      stream_chars_used: row.stream_chars_used ?? 0,
      stream_max_chars: row.stream_max_chars ?? null,
      segments,
      price_estimate_eur: row.price_estimate_eur ?? null,
      parent_job_id: row.parent_job_id ?? null,
      stream_url:
        row.job_kind === "stream" ? `/api/jobs/${job.id}/stream` : undefined,
      audio_url: job.audio_storage_path
        ? `/api/storage/${job.audio_storage_path}`
        : undefined,
      created_at: new Date(job.created_at * 1000).toISOString(),
      updated_at: new Date(job.updated_at * 1000).toISOString(),
    };

    return NextResponse.json({ job: formattedJob });
  } catch (error) {
    console.error("Get job error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const job = await getJob(id);

    if (job) {
      // H8: Collect all paths to delete — pdf, audio, and all segment files
      const pathsToDelete = new Set(
        [job.pdf_storage_path, job.audio_storage_path].filter(
          (p): p is string => Boolean(p)
        )
      );

      // Parse segments_json and add segment paths
      const row = job as typeof job & Record<string, unknown>;
      if (typeof row.segments_json === "string" && row.segments_json) {
        try {
          const segments = JSON.parse(row.segments_json as string) as JobSegment[];
          for (const seg of segments) {
            if (seg.path) pathsToDelete.add(seg.path);
          }
        } catch {
          // ignore parse errors
        }
      }

      // Also clean up the original upload folder (pdfs/<uuid>/…), not just content.txt
      if (job.pdf_storage_path) {
        try {
          const parts = job.pdf_storage_path.split("/");
          // e.g. pdfs/<uuid>/content.txt → pdfs/<uuid>
          if (parts.length >= 2 && parts[0] === "pdfs") {
            const uploadPrefix = parts.slice(0, 2).join("/");
            const uploadFiles = await listFiles(uploadPrefix);
            for (const f of uploadFiles) pathsToDelete.add(f);
          }
        } catch {
          // ignore
        }
      }

      // Also list and delete all files under audiobooks/<id>/ prefix in R2
      try {
        const segmentFiles = await listFiles(`audiobooks/${id}`);
        for (const segmentFile of segmentFiles) {
          pathsToDelete.add(segmentFile);
        }
      } catch {
        // ignore listing errors
      }

      for (const filePath of pathsToDelete) {
        try {
          await deleteFile(filePath);
        } catch (err) {
          console.warn(`[Job ${id}] Failed to delete file ${filePath}:`, err);
        }
      }
    }

    await deleteJob(id);
    return NextResponse.json({ success: true, message: "Job deleted" });
  } catch (error) {
    console.error("Delete job error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    if (body.action === "retry") {
      const job = await getJob(id);
      if (!job) {
        return NextResponse.json({ error: "Job not found" }, { status: 404 });
      }

      if (job.status !== "failed") {
        return NextResponse.json(
          { error: "Can only retry failed jobs" },
          { status: 400 }
        );
      }

      await resetJob(id);

      const { chainTakehomeContinue } = await import("@/lib/tts/process-job");
      const { execute } = await import("@/lib/turso");
      await execute(
        `UPDATE jobs SET next_section_index = 0, segments_json = NULL, progress = 0,
         audio_storage_path = NULL, status = 'queued', error_message = NULL,
         processing_started_at = NULL, updated_at = unixepoch() WHERE id = ?`,
        [id]
      );
      chainTakehomeContinue(id);

      return NextResponse.json({
        success: true,
        message: "Job reset and generation restarted",
      });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (error) {
    console.error("Patch job error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
