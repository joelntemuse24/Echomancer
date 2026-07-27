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

    // Player polls every ~3s — await short inline wave for stale queued take-homes
    const { nudgeStaleTakehomeJobIfNeeded } = await import("@/lib/tts/process-job");
    await nudgeStaleTakehomeJobIfNeeded({
      id: job.id,
      job_kind: typeof row.job_kind === "string" ? row.job_kind : null,
      status: job.status,
      updated_at: job.updated_at,
    });

    // Re-read after possible nudge so progress/segments are fresh
    const refreshed = await getJob(id);
    const jobFresh = refreshed ?? job;
    const rowFresh = jobFresh as typeof jobFresh & Record<string, unknown>;

    let segments = null;
    if (typeof rowFresh.segments_json === "string" && rowFresh.segments_json) {
      try {
        segments = JSON.parse(rowFresh.segments_json as string);
      } catch {
        segments = null;
      }
    }

    // H9: Exclude internal storage paths from public response
    const { estimateJobEtaSeconds, estimateElapsedSeconds, formatFriendlyGenerationEta, formatElapsedSeconds } =
      await import("@/lib/tts/eta");
    const generationStartedAt =
      typeof rowFresh.generation_started_at === "number"
        ? (rowFresh.generation_started_at as number)
        : null;
    const etaSeconds = estimateJobEtaSeconds({
      status: jobFresh.status,
      current_section: jobFresh.current_section,
      total_sections: jobFresh.total_sections,
      progress: jobFresh.progress,
      generation_started_at: generationStartedAt,
      created_at: jobFresh.created_at,
      char_count:
        typeof rowFresh.char_count === "number"
          ? (rowFresh.char_count as number)
          : null,
    });
    const elapsedSeconds = estimateElapsedSeconds({
      status: jobFresh.status,
      generation_started_at: generationStartedAt,
      created_at: jobFresh.created_at,
    });

    const formattedJob = {
      id: jobFresh.id,
      book_title: jobFresh.book_title,
      voice_name: jobFresh.voice_name,
      status: jobFresh.status,
      progress: jobFresh.progress,
      current_section: jobFresh.current_section,
      total_sections: jobFresh.total_sections,
      duration_seconds: jobFresh.duration_seconds,
      error_message: jobFresh.error_message,
      generation_mode: rowFresh.generation_mode ?? "stock",
      job_kind: rowFresh.job_kind ?? "takehome",
      tts_provider: rowFresh.tts_provider ?? null,
      provider_voice_id: rowFresh.provider_voice_id ?? null,
      catalog_voice_id: rowFresh.catalog_voice_id ?? null,
      char_count: rowFresh.char_count ?? 0,
      stream_cursor: rowFresh.stream_cursor ?? 0,
      stream_chars_used: rowFresh.stream_chars_used ?? 0,
      stream_max_chars: rowFresh.stream_max_chars ?? null,
      segments,
      price_estimate_eur: rowFresh.price_estimate_eur ?? null,
      parent_job_id: rowFresh.parent_job_id ?? null,
      stream_url:
        rowFresh.job_kind === "stream" ? `/api/jobs/${jobFresh.id}/stream` : undefined,
      audio_url: jobFresh.audio_storage_path
        ? `/api/storage/${jobFresh.audio_storage_path}`
        : undefined,
      eta_seconds: etaSeconds,
      eta_label: formatFriendlyGenerationEta(etaSeconds, {
        sectionsDone: jobFresh.current_section,
        live: (jobFresh.current_section || 0) >= 2,
      }),
      elapsed_seconds: elapsedSeconds,
      elapsed_label: formatElapsedSeconds(elapsedSeconds),
      created_at: new Date(jobFresh.created_at * 1000).toISOString(),
      updated_at: new Date(jobFresh.updated_at * 1000).toISOString(),
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

      const { continueTakehome } = await import("@/lib/tts/process-job");
      const { execute } = await import("@/lib/turso");
      await execute(
        `UPDATE jobs SET next_section_index = 0, segments_json = NULL, progress = 0,
         audio_storage_path = NULL, status = 'queued', error_message = NULL,
         processing_started_at = NULL, updated_at = unixepoch() WHERE id = ?`,
        [id]
      );
      await continueTakehome(id);

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
