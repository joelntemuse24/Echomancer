import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteJob } from "@/lib/turso/jobs";
import { execute, query } from "@/lib/turso";
import { handleApiError } from "@/lib/errors";
import { requireOwnedJob } from "@/lib/auth/guard";
import { serializeJob } from "@/lib/jobs/serialize";
import { withDirectDownloadUrl } from "@/lib/jobs/direct-download";
import { playbackChaptersFromSections } from "@/lib/player/playback-chapters";
import { durationsFromSectionStarts } from "@/lib/tts/section-clock";
import {
  sanitizePlaybackChapters,
  type PlayerChapter,
} from "@/lib/player/chapter-nav";
import { deleteFile, downloadFile, listFiles } from "@/lib/storage";
import {
  playbackChaptersPath,
  sectionStartsPath,
  loadFrozenSectionOutline,
} from "@/lib/tts/frozen-script";
import type { JobSegment } from "@/lib/tts/types";
import { nudgeStaleTakehomeJobIfNeeded } from "@/lib/tts/process-job";
import { enqueueTakehomeAdvance } from "@/lib/jobs/takehome-dispatch";
import { advanceStuckExtract } from "@/lib/jobs/dispatch-extract";
import { getUploadByStoragePath, uploadStatus } from "@/lib/turso/uploads";
import {
  lowestUnreadyIndex,
  parseSegmentMap,
  readyCount,
} from "@/lib/tts/section-index";
import { isRetiredGoogleSynthesis } from "@/lib/tts/standard-voice";

export const runtime = "nodejs";
export const maxDuration = 60;

const renameSchema = z.object({
  bookTitle: z
    .string()
    .transform((title) => title.replace(/\s+/g, " ").trim())
    .pipe(z.string().min(1).max(200)),
});

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
    let serialized = await withDirectDownloadUrl(
      serializeJob(refreshed.job),
      refreshed.job
    );
    const wait = await advanceWaitingText(refreshed.job);
    if (wait.failedMessage) {
      serialized = {
        ...serialized,
        status: "failed",
        error_message: wait.failedMessage,
      };
    }
    const chapters = await chaptersForReadyJob(refreshed.job);
    return NextResponse.json({
      job: {
        ...serialized,
        ...(chapters.length > 0 ? { chapters } : {}),
        ...(wait.waitingForText ? { waiting_for_text: true } : {}),
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

interface WaitingTextState {
  waitingForText: boolean;
  failedMessage?: string;
}

/**
 * The player is the only poller once the voice page is gone. A job whose
 * upload is still extracting stays "Reading your book…" here. The path
 * comes from a job this session owns, so the storage lookup is not a
 * second ownership check. Each read calls `advanceStuckExtract` (Node,
 * then Cloudflare, then Vercel, one cap) and fails a parked job whose
 * upload failed, so the wait always resolves.
 */
async function advanceWaitingText(
  job: Record<string, unknown>
): Promise<WaitingTextState> {
  const jobKind = typeof job.job_kind === "string" ? job.job_kind : null;
  if (jobKind !== "takehome") return { waitingForText: false };
  const status = typeof job.status === "string" ? job.status : "";
  if (status !== "queued" && status !== "waiting" && status !== "processing") {
    return { waitingForText: false };
  }
  const storagePath =
    typeof job.pdf_storage_path === "string" ? job.pdf_storage_path : "";
  if (!storagePath) return { waitingForText: false };
  try {
    const upload = await getUploadByStoragePath(storagePath);
    if (!upload) return { waitingForText: false };
    const uploadState = uploadStatus(upload);
    if (uploadState === "ready") return { waitingForText: false };
    if (uploadState === "failed") {
      const message =
        upload.error_message || "Couldn't read this. Try another file.";
      // A parked job fails here (its worker tick would do the same) so the
      // player shows the real reason without waiting on a drain. A processing
      // job belongs to the worker holding the lease.
      if (status === "queued" || status === "waiting") {
        await execute(
          `UPDATE jobs SET status = 'failed', error_message = ?,
             processing_lease_token = NULL, lease_expires_at = NULL,
             updated_at = unixepoch()
           WHERE id = ? AND status IN ('queued', 'waiting') AND deleted_at IS NULL`,
          [message, String(job.id)]
        ).catch(() => {});
      }
      return { waitingForText: false, failedMessage: message };
    }
    await advanceStuckExtract(upload.id).catch(() => {});
    return { waitingForText: true };
  } catch {
    return { waitingForText: false };
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

    if (body.action === "rename") {
      const parsed = renameSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json(
          { error: "Title must be 1–200 characters" },
          { status: 400 }
        );
      }
      await requireOwnedJob(request, id);
      await execute(
        `UPDATE jobs SET book_title = ?, updated_at = unixepoch() WHERE id = ?`,
        [parsed.data.bookTitle, id]
      );
      return NextResponse.json({ success: true, bookTitle: parsed.data.bookTitle });
    }

    if (body.action !== "retry") {
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }

    const { job } = await requireOwnedJob(request, id);
    if (
      isRetiredGoogleSynthesis({
        provider: typeof job.tts_provider === "string" ? job.tts_provider : null,
        providerVoiceId:
          typeof job.provider_voice_id === "string" ? job.provider_voice_id : null,
      })
    ) {
      return NextResponse.json(
        {
          error:
            "Saved audio for this book is still available. This narrator cannot be generated again.",
        },
        { status: 409 }
      );
    }
    if (job.status !== "failed") {
      return NextResponse.json(
        { error: "Can only retry failed jobs" },
        { status: 400 }
      );
    }

    const segments = parseSegmentMap(
      typeof job.segments_json === "string" ? job.segments_json : null
    );
    const total =
      typeof job.total_sections === "number" && job.total_sections > 0
        ? job.total_sections
        : segments.length;
    const nextIndex = lowestUnreadyIndex(segments, total || 0);
    const done = readyCount(segments);

    // Resume from the lowest unready index. Ready section files stay put.
    await execute(
      `UPDATE jobs SET status = 'queued', progress = ?, current_section = ?,
       next_section_index = ?, error_message = NULL,
       processing_started_at = NULL, processing_lease_token = NULL,
       lease_expires_at = NULL, audio_storage_path = NULL,
       updated_at = unixepoch()
       WHERE id = ?`,
      [
        total > 0 ? Math.min(99, Math.round((done / total) * 100)) : 0,
        done,
        nextIndex,
        id,
      ]
    );

    if (job.job_kind === "takehome" || job.job_kind == null) {
      await enqueueTakehomeAdvance(id);
    }

    return NextResponse.json({
      success: true,
      message: "Job requeued — generation restarts shortly",
    });
  } catch (error) {
    return handleApiError(error);
  }
}

async function readStoredPlaybackChapters(jobId: string): Promise<PlayerChapter[] | null> {
  try {
    const parsed = JSON.parse(
      (await downloadFile(playbackChaptersPath(jobId))).toString("utf8")
    ) as { chapters?: unknown };
    if (!Array.isArray(parsed.chapters)) return null;
    // Optional subtitle, level, and children pass through. Detection stays elsewhere.
    return sanitizePlaybackChapters(parsed.chapters);
  } catch {
    return null;
  }
}

async function readStoredSectionStarts(
  jobId: string
): Promise<{ sectionStarts: number[]; totalSeconds: number } | null> {
  try {
    const parsed = JSON.parse((await downloadFile(sectionStartsPath(jobId))).toString("utf8")) as {
      sectionStarts?: unknown;
      totalSeconds?: unknown;
    };
    if (!Array.isArray(parsed.sectionStarts) || typeof parsed.totalSeconds !== "number") return null;
    if (!(parsed.totalSeconds > 0)) return null;
    const sectionStarts: number[] = [];
    for (let i = 0; i < parsed.sectionStarts.length; i++) {
      const start = parsed.sectionStarts[i];
      if (typeof start === "number" && Number.isFinite(start)) sectionStarts[i] = start;
    }
    if (!sectionStarts.some((start) => Number.isFinite(start))) return null;
    return { sectionStarts, totalSeconds: parsed.totalSeconds };
  } catch {
    return null;
  }
}

/** Titled chapters for a finished whole book. Empty while it is still generating. */
async function chaptersForReadyJob(job: Record<string, unknown>) {
  if (job.status !== "ready" || job.job_kind === "stream") return [];
  const stored = await readStoredPlaybackChapters(String(job.id));
  if (stored) return stored;
  const sections = await loadFrozenSectionOutline(String(job.id));
  if (!sections?.length) return [];
  const measured = await readStoredSectionStarts(String(job.id));
  if (measured) {
    return playbackChaptersFromSections(
      sections,
      durationsFromSectionStarts(measured.sectionStarts, measured.totalSeconds)
    );
  }
  const segments = parseSegmentMap(
    typeof job.segments_json === "string" ? job.segments_json : null
  );
  return playbackChaptersFromSections(sections, segments);
}

/** `pdfs/<uploadId>/content.txt` → `pdfs/<uploadId>` */
function uploadFolderFor(pdfStoragePath: unknown): string | null {
  if (typeof pdfStoragePath !== "string") return null;
  const parts = pdfStoragePath.split("/");
  if (parts.length < 2 || parts[0] !== "pdfs") return null;
  return parts.slice(0, 2).join("/");
}
