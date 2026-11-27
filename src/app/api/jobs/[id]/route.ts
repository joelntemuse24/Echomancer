import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { execute } from "@/lib/turso";
import { handleApiError } from "@/lib/errors";
import {
  requireOwnedJob,
  requireOwnedJobIncludingDeleted,
} from "@/lib/auth/guard";
import { signPlaybackGrant } from "@/lib/auth/playback-grant";
import {
  scheduleDeletedJobPurge,
  softDeleteJob,
} from "@/lib/jobs/delete-owned-job";
import { forgetModalCloneJob } from "@/lib/tts/providers/modal-clone";
import { serializeJob } from "@/lib/jobs/serialize";
import { withDirectDownloadUrl } from "@/lib/jobs/direct-download";
import { resumeFields } from "@/lib/player/playback-position";
import { getPlaybackPosition } from "@/lib/turso/playback-positions";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { playbackChaptersFromSections } from "@/lib/player/playback-chapters";
import { durationsFromSectionStarts } from "@/lib/tts/section-clock";
import {
  sanitizePlaybackChapters,
  type PlayerChapter,
} from "@/lib/player/chapter-nav";
import { downloadFile } from "@/lib/storage";
import {
  playbackChaptersPath,
  sectionStartsPath,
  loadFrozenSectionOutline,
} from "@/lib/tts/frozen-script";
import { nudgeStaleTakehomeJobIfNeeded } from "@/lib/tts/process-job";
import { enqueueTakehomeAdvance } from "@/lib/jobs/takehome-dispatch";
import { advanceStuckExtract } from "@/lib/jobs/dispatch-extract";
import { getUploadByStoragePath, uploadStatus } from "@/lib/turso/uploads";
import {
  lowestUnreadyIndex,
  parseSegmentMap,
  readyCount,
} from "@/lib/tts/section-index";
import { narrationProgressPercent } from "@/lib/tts/narration-progress";
import { isRetiredGoogleSynthesis } from "@/lib/tts/standard-voice";
import { recoveryHoldReason } from "@/lib/modal/workspace-disabled";
import { looksLikeFileName, normalizeStoredBookTitle } from "@/lib/book-title";

export const runtime = "nodejs";
export const maxDuration = 60;

const renameSchema = z.object({
  bookTitle: z
    .string()
    .transform((title) => title.replace(/\s+/g, " ").trim())
    // A rename that arrives as a raw file name is still a file name. A title
    // the person typed keeps its own casing.
    .transform((title) =>
      looksLikeFileName(title) || title.includes("_")
        ? normalizeStoredBookTitle(title)
        : title
    )
    .pipe(z.string().min(1).max(200)),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await ensureTtsJobColumns();
    const { id } = await params;
    const { job } = await requireOwnedJob(request, id);

    // The player polls this endpoint, which makes it a convenient place to
    // return leases abandoned by a crashed worker. It does not synthesize
    // unless TTS_POLL_NUDGE_BUDGET_MS is non-zero. A nudge that moved nothing
    // leaves this row current, so a poll usually pays for one read.
    const nudged = await nudgeStaleTakehomeJobIfNeeded({
      id: job.id,
      job_kind: typeof job.job_kind === "string" ? job.job_kind : null,
      status: job.status,
      updated_at: typeof job.updated_at === "number" ? job.updated_at : 0,
    });
    const current = nudged ? (await requireOwnedJob(request, id)).job : job;

    let serialized = await withDirectDownloadUrl(
      serializeJob(current),
      current
    );
    const wait = mayBeWaitingForText(current)
      ? await advanceWaitingText(current)
      : { waitingForText: false };
    if (wait.failedMessage) {
      serialized = {
        ...serialized,
        status: "failed",
        error_message: wait.failedMessage,
      };
    }
    // Only a finished book has stored timings and chapters to read; a
    // generating job polls every couple of seconds and pays for neither.
    let chapters: PlayerChapter[] = [];
    if (serialized.status === "ready") {
      // A copy-joined book's byte length says nothing about its play time. Fill
      // the measured length here so the player has it before metadata loads.
      if (!serialized.duration_seconds) {
        const measured = await readStoredSectionStarts(id);
        if (measured?.totalSeconds) {
          serialized = { ...serialized, duration_seconds: Math.round(measured.totalSeconds) };
        }
      }
      chapters = await chaptersForReadyJob(current);
    }
    let resume = null;
    try {
      resume = await getPlaybackPosition(String(current.user_id), id);
    } catch (error) {
      console.error("resume position unavailable:", error);
    }
    const ownerId = typeof current.user_id === "string" ? current.user_id : "";
    return NextResponse.json({
      job: {
        ...serialized,
        ...resumeFields(resume),
        ...(chapters.length > 0 ? { chapters } : {}),
        ...(wait.waitingForText ? { waiting_for_text: true } : {}),
        ...(ownerId
          ? {
              playback_grant: signPlaybackGrant(
                ownerId,
                `audiobooks/${id}`,
                Date.now(),
                Number(current.playback_nonce ?? 0) || 0
              ),
            }
          : {}),
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
 * The early returns of {@link advanceWaitingText}: a take-home that has not
 * started, parked on its upload. Only those rows are worth the upload lookup,
 * so a poll of a generating or finished book skips it entirely.
 */
function mayBeWaitingForText(job: Record<string, unknown>): boolean {
  if (job.job_kind !== "takehome") return false;
  const status = typeof job.status === "string" ? job.status : "";
  if (status !== "queued" && status !== "waiting" && status !== "processing") {
    return false;
  }
  return typeof job.pdf_storage_path === "string" && job.pdf_storage_path !== "";
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
    const { job } = await requireOwnedJobIncludingDeleted(request, id);

    // The row leaves the library before any object is removed. Storage for a
    // long book can outlast this function; a retry of an already-deleted row
    // still reaches this point and purges again.
    await softDeleteJob(job.id, job.user_id);
    forgetModalCloneJob(job.id);
    // Stop a finalize that is already in flight before its files go away. A
    // worker holds the lease and would otherwise publish (`ready`) a row the
    // user just deleted, or upload a full file long after the delete.
    const { stopBookRemotely } = await import("@/lib/remote/stop");
    await stopBookRemotely(job.id, "deleted");
    await scheduleDeletedJobPurge({
      jobId: job.id,
      userId: job.user_id,
      pdfStoragePath: job.pdf_storage_path,
    });
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
      const renamed = await execute(
        `UPDATE jobs SET book_title = ?, updated_at = unixepoch()
         WHERE id = ? AND deleted_at IS NULL`,
        [parsed.data.bookTitle, id]
      );
      if (renamed.rowsAffected === 0) {
        return NextResponse.json({ error: "Job not found" }, { status: 404 });
      }
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
    const held = recoveryHoldReason(
      typeof job.error_message === "string" ? job.error_message : null
    );
    if (held) {
      return NextResponse.json(
        {
          error: held,
          recovery: "wait",
        },
        { status: 409 }
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
    // Timings restart with the attempt: ETA measures throughput from the first
    // section of this run, not from one finished days ago.
    const requeued = await execute(
      `UPDATE jobs SET status = 'queued', progress = ?, current_section = ?,
       next_section_index = ?, error_message = NULL,
       processing_started_at = NULL, processing_lease_token = NULL,
       lease_expires_at = NULL, audio_storage_path = NULL,
       generation_started_at = NULL, first_section_at = NULL,
       last_section_at = NULL,
       updated_at = unixepoch()
       WHERE id = ? AND deleted_at IS NULL AND status = 'failed'`,
      [
        narrationProgressPercent(done, total),
        done,
        nextIndex,
        id,
      ]
    );
    if (requeued.rowsAffected === 0) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

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
