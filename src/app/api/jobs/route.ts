import { NextRequest, NextResponse } from "next/server";
import { createJobSchema, paginationSchema } from "@/lib/validation";
import { AppError, handleApiError } from "@/lib/errors";
import { randomUUID } from "crypto";
import { createRateLimiter } from "@/lib/rate-limit";
import { execute, query, queryOne } from "@/lib/turso";

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

    const voicePathStr = parsed.voiceStoragePath
      ? parsed.voiceStoragePath.split(",").map((p) => p.trim()).sort().join(",")
      : "";

    // Deduplication
    const existing = await query<{
      id: string; status: string; audio_storage_path: string;
    }>(
      `SELECT id, status, audio_storage_path FROM jobs
       WHERE pdf_storage_path = ? AND voice_storage_path = ?
       AND start_time = ? AND end_time = ? AND status = 'ready' AND deleted_at IS NULL LIMIT 1`,
      [parsed.pdfStoragePath, voicePathStr, parsed.startTime, parsed.endTime]
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
       pdf_storage_path, voice_storage_path, start_time, end_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        jobId, "anonymous", parsed.bookTitle, parsed.voiceName, "queued", 0,
        parsed.pdfStoragePath, voicePathStr || null,
        parsed.startTime, parsed.endTime,
      ]
    );

    // Trigger Modal generation
    const modalUrl = process.env.MODAL_TTS_URL;
    if (modalUrl) {
      const baseUrl = modalUrl.replace("/generate_batch", "");
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
      const voicePaths = parsed.voiceStoragePath
        ? parsed.voiceStoragePath.split(",").map(p => p.trim()).filter(Boolean)
        : [];

      fetch(`${baseUrl}/generate_audiobook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_id: jobId,
          pdf_r2_key: parsed.pdfStoragePath,
          voice_r2_key: voicePaths[0] || "",
          start_time: parsed.startTime,
          end_time: parsed.endTime,
          webhook_url: `${appUrl}/api/jobs/${jobId}/webhook`,
          book_title: parsed.bookTitle,
          voice_name: parsed.voiceName,
          r2_bucket_name: process.env.R2_BUCKET_NAME || "echomancer-audio",
        }),
      }).catch((err) => {
        console.error(`[Job ${jobId}] Failed to trigger Modal:`, err);
      });
    }

    return NextResponse.json({
      jobId,
      status: "queued",
      message: "Job created and generation triggered",
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function GET(request: NextRequest) {
  try {
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
