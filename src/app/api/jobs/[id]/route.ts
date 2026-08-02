import { NextRequest, NextResponse } from "next/server";
import { deleteJob } from "@/lib/turso/jobs";
import { execute, query } from "@/lib/turso";
import { handleApiError } from "@/lib/errors";
import { requireOwnedJob } from "@/lib/auth/guard";
import { serializeJob } from "@/lib/jobs/serialize";
import { deleteFile, listFiles } from "@/lib/storage";
import type { JobSegment } from "@/lib/tts/types";
import { nudgeStaleTakehomeJobIfNeeded } from "@/lib/tts/process-job";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { job } = await requireOwnedJob(request, id);

    // The player polls this endpoint, which makes it a convenient place to
    // return leases abandoned by a crashed worker. It does not synthesize
    // unless TTS_POLL_NUDGE_BUDGET_MS is non-zero.
    await nudgeStaleTakehomeJobIfNeeded({
      id: job.id,
      job_kind: typeof job.job_kind === "string" ? job.job_kind : null,
      status: job.status,
      updated_at: typeof job.updated_at === "number" ? job.updated_at : 0,
    });

    const refreshed = await requireOwnedJob(request, id);
    return NextResponse.json({ job: serializeJob(refreshed.job) });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { job } = await requireOwnedJob(request, id);

    const pathsToDelete = new Set<string>();

    // Everything under `audiobooks/<jobId>/` belongs to this job alone, so it
    // can always go: sections, the assembled full file, and any stale leftovers.
    if (typeof job.audio_storage_path === "string" && job.audio_storage_path) {
      pathsToDelete.add(job.audio_storage_path);
    }
    if (typeof job.segments_json === "string" && job.segments_json) {
      try {
        for (const seg of JSON.parse(job.segments_json) as JobSegment[]) {
          if (seg.path) pathsToDelete.add(seg.path);
        }
      } catch {
        /* a malformed segment list still lets the prefix listing below clean up */
      }
    }
    try {
      for (const file of await listFiles(`audiobooks/${id}`)) {
        pathsToDelete.add(file);
      }
    } catch {
      /* listing failures must not block the row delete */
    }

    // The uploaded document is shared: Live Stream and whole-book jobs
    // are separate jobs over the same `pdfs/<uploadId>/` folder. Deleting it
    // while a sibling still exists would break that sibling's playback and any
    // future retry, so only the last job to reference it may remove it.
    const uploadFolder = uploadFolderFor(job.pdf_storage_path);
    if (uploadFolder) {
      const siblings = await query<{ count: number }>(
        `SELECT COUNT(*) as count FROM jobs
         WHERE pdf_storage_path = ? AND id != ? AND deleted_at IS NULL`,
        [job.pdf_storage_path, id]
      );
      const siblingCount = siblings[0]?.count ?? 0;
      if (siblingCount === 0) {
        try {
          for (const file of await listFiles(uploadFolder)) {
            pathsToDelete.add(file);
          }
        } catch {
          /* ignore */
        }
        await execute(`DELETE FROM uploads WHERE storage_path = ?`, [
          job.pdf_storage_path,
        ]).catch(() => {});
      } else {
        console.log(
          `[Job ${id}] keeping ${uploadFolder} — ${siblingCount} sibling job(s) still use it`
        );
      }
    }

    for (const filePath of pathsToDelete) {
      try {
        await deleteFile(filePath);
      } catch (err) {
        console.warn(`[Job ${id}] failed to delete ${filePath}:`, err);
      }
    }

    await deleteJob(id);
    return NextResponse.json({ success: true, message: "Job deleted" });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));

    if (body.action !== "retry") {
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }

    const { job } = await requireOwnedJob(request, id);
    if (job.status !== "failed") {
      return NextResponse.json(
        { error: "Can only retry failed jobs" },
        { status: 400 }
      );
    }

    // Requeue from scratch; the worker will claim it on its next pass.
    await execute(
      `UPDATE jobs SET status = 'queued', progress = 0, current_section = 0,
       next_section_index = 0, segments_json = NULL, audio_storage_path = NULL,
       error_message = NULL, processing_started_at = NULL,
       processing_lease_token = NULL, lease_expires_at = NULL,
       generation_started_at = NULL, updated_at = unixepoch()
       WHERE id = ?`,
      [id]
    );

    return NextResponse.json({
      success: true,
      message: "Job requeued — generation restarts shortly",
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/** `pdfs/<uploadId>/content.txt` → `pdfs/<uploadId>` */
function uploadFolderFor(pdfStoragePath: unknown): string | null {
  if (typeof pdfStoragePath !== "string") return null;
  const parts = pdfStoragePath.split("/");
  if (parts.length < 2 || parts[0] !== "pdfs") return null;
  return parts.slice(0, 2).join("/");
}
