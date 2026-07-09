import { NextRequest, NextResponse } from "next/server";
import { createJobSchema, paginationSchema } from "@/lib/validation";
import { AppError, handleApiError } from "@/lib/errors";
import { randomUUID } from "crypto";
import { createRateLimiter } from "@/lib/rate-limit";
import { execute, query, queryOne } from "@/lib/turso";
import { triggerAudiobookGeneration } from "@/lib/trigger-generation";
import { resolveTtsRoute } from "@/lib/tts-config";
import { ensureJobRoutingColumns } from "@/lib/turso/schema";
import { updateJob } from "@/lib/turso/jobs";
import { downloadFile } from "@/lib/storage";

const checkRateLimit = createRateLimiter(5, 60_000);

export async function POST(request: NextRequest) {
  try {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (!checkRateLimit(ip)) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a minute before creating another job." },
        { status: 429 }
      );
    }

    const body = await request.json();
    const parsed = createJobSchema.parse(body);
    await ensureJobRoutingColumns();
    let charCount: number;
    let paragraphCount: number;
    try {
      const content = (await downloadFile(parsed.pdfStoragePath)).toString("utf-8");
      if (!content.trim()) {
        throw new Error("Extracted book text is empty");
      }
      charCount = content.length;
      paragraphCount = content.split(/\n\s*\n/).filter((part) => part.trim()).length;
    } catch (error) {
      console.error(`[Jobs] Could not verify text size for ${parsed.pdfStoragePath}`, error);
      throw new AppError(
        "BOOK_TEXT_UNAVAILABLE",
        "Could not read the extracted book text. Please upload the book again.",
        422
      );
    }
    const ttsRoute = resolveTtsRoute("audiobook", {
      charCount,
      paragraphCount,
    });

    const voicePathStr = parsed.voiceStoragePath
      ? parsed.voiceStoragePath.split(",").map((p) => p.trim()).sort().join(",")
      : "";

    // Deduplication
    const existing = await query<{
      id: string; status: string; audio_storage_path: string;
    }>(
      `SELECT id, status, audio_storage_path FROM jobs
       WHERE pdf_storage_path = ? AND voice_storage_path = ?
       AND start_time = ? AND end_time = ? AND tts_variant = ?
       AND status = 'ready' AND deleted_at IS NULL LIMIT 1`,
      [
        parsed.pdfStoragePath,
        voicePathStr,
        parsed.startTime,
        parsed.endTime,
        ttsRoute.variant,
      ]
    );

    if (existing.length > 0) {
      return NextResponse.json({
        jobId: existing[0]!.id,
        status: "ready",
        message: "This audiobook already exists — returning existing job.",
        duplicate: true,
      });
    }

    const jobId = randomUUID();

    await execute(
      `INSERT INTO jobs (id, user_id, book_title, voice_name, status, progress,
       pdf_storage_path, voice_storage_path, start_time, end_time, tts_variant,
       char_count, paragraph_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        jobId, "anonymous", parsed.bookTitle, parsed.voiceName, "queued", 0,
        parsed.pdfStoragePath, voicePathStr || null,
        parsed.startTime, parsed.endTime, ttsRoute.variant,
        charCount ?? null, paragraphCount ?? null,
      ]
    );

    // Trigger Modal generation (shared with the retry path)
    try {
      await triggerAudiobookGeneration({
        jobId,
        pdfStoragePath: parsed.pdfStoragePath,
        voiceStoragePath: parsed.voiceStoragePath,
        startTime: parsed.startTime,
        endTime: parsed.endTime,
        bookTitle: parsed.bookTitle,
        voiceName: parsed.voiceName,
        charCount,
        paragraphCount,
        mossAbVariant: ttsRoute.variant,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "TTS service rejected the job";
      await updateJob(jobId, { status: "failed", error_message: message });
      throw new AppError("TTS_TRIGGER_FAILED", message, 502);
    }

    return NextResponse.json({
      jobId,
      status: "queued",
      ttsVariant: ttsRoute.variant,
      message: "Job created and generation triggered",
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function GET(request: NextRequest) {
  try {
    await ensureJobRoutingColumns();
    const { searchParams } = new URL(request.url);
    const { page, limit } = paginationSchema.parse({
      page: searchParams.get("page") || "1",
      limit: searchParams.get("limit") || "20",
    });

    const offset = (page - 1) * limit;

    const countResult = await queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM jobs WHERE deleted_at IS NULL`
    );
    const count = countResult?.count ?? 0;

    const jobs = await query<{
      id: string; user_id: string; book_title: string;
      pdf_storage_path: string; voice_storage_path: string | null;
      voice_name: string | null; video_id: string | null;
      start_time: number; end_time: number; status: string;
      progress: number; current_section: number; total_sections: number;
      audio_storage_path: string | null; duration_seconds: number | null;
      error_message: string | null; created_at: number; updated_at: number;
      tts_variant: string | null; char_count: number | null;
      paragraph_count: number | null;
    }>(
      `SELECT * FROM jobs WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );

    const formattedJobs = jobs.map((job) => ({
      id: job.id,
      user_id: job.user_id,
      book_title: job.book_title,
      pdf_storage_path: job.pdf_storage_path,
      voice_storage_path: job.voice_storage_path,
      voice_name: job.voice_name,
      video_id: job.video_id,
      start_time: job.start_time,
      end_time: job.end_time,
      status: job.status,
      progress: job.progress,
      current_section: job.current_section,
      total_sections: job.total_sections,
      audio_storage_path: job.audio_storage_path,
      duration_seconds: job.duration_seconds,
      error_message: job.error_message,
      tts_variant: job.tts_variant,
      char_count: job.char_count,
      paragraph_count: job.paragraph_count,
      created_at: new Date(job.created_at * 1000).toISOString(),
      updated_at: new Date(job.updated_at * 1000).toISOString(),
    }));

    return NextResponse.json({
      jobs: formattedJobs,
      pagination: { page, limit, total: count, totalPages: Math.ceil(count / limit) },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
