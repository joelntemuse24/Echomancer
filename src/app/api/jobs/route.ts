import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createJobSchema, paginationSchema } from "@/lib/validation";
import { AppError, handleApiError } from "@/lib/errors";
import { randomUUID } from "crypto";
import { generateAudiobookV2 } from "@/lib/generate-audiobook-v2";
import { createRateLimiter } from "@/lib/rate-limit";

const checkRateLimit = createRateLimiter(5, 60_000);

export async function POST(request: NextRequest) {
  try {
    // Rate limit check
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (!checkRateLimit(ip)) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a minute before creating another job." },
        { status: 429 }
      );
    }

    const body = await request.json();
    const parsed = createJobSchema.parse(body);

    // Deduplication: check if a "ready" job already exists with same PDF+voice+clip
    const checkStmt = db.prepare(`
      SELECT id, status, audio_storage_path 
      FROM jobs 
      WHERE pdf_storage_path = ? 
        AND voice_storage_path = ? 
        AND start_time = ? 
        AND end_time = ? 
        AND status = 'ready'
      LIMIT 1
    `);
    
    const voicePathStr = parsed.voiceStoragePath 
      ? parsed.voiceStoragePath.split(",").map(p => p.trim()).sort().join(",")
      : "";
    
    const existingJob = checkStmt.get(
      parsed.pdfStoragePath,
      voicePathStr,
      parsed.startTime,
      parsed.endTime
    ) as { id: string; status: string; audio_storage_path: string } | undefined;

    if (existingJob) {
      return NextResponse.json({
        jobId: existingJob.id,
        status: "ready",
        message: "This audiobook already exists — returning existing job.",
        duplicate: true,
      });
    }

    const jobId = randomUUID();

    // Insert new job
    const insertStmt = db.prepare(`
      INSERT INTO jobs (
        id, user_id, book_title, voice_name, status, progress,
        pdf_storage_path, voice_storage_path, video_id,
        start_time, end_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(
      jobId,
      "anonymous",
      parsed.bookTitle,
      parsed.voiceName,
      "queued",
      0,
      parsed.pdfStoragePath,
      voicePathStr || null,
      parsed.videoId || null,
      parsed.startTime,
      parsed.endTime
    );

    // Fire and forget — generation runs in the background
    const voicePaths = parsed.voiceStoragePath 
      ? parsed.voiceStoragePath.split(',').filter(p => p.trim())
      : [];
    
    generateAudiobookV2({
      jobId,
      pdfStoragePath: parsed.pdfStoragePath,
      voiceStoragePath: voicePaths[0] || null,
      voiceStoragePaths: voicePaths.length > 1 ? voicePaths : undefined,
      videoId: parsed.videoId || null,
      startTime: parsed.startTime,
      endTime: parsed.endTime,
    }).catch((err) => {
      console.error(`[Job ${jobId}] Unhandled error:`, err);
    });

    return NextResponse.json({
      jobId,
      status: "queued",
      message: "Job created successfully",
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

    // Get total count
    const countStmt = db.prepare(`SELECT COUNT(*) as count FROM jobs WHERE deleted_at IS NULL`);
    const { count } = countStmt.get() as { count: number };

    // Get jobs
    const jobsStmt = db.prepare(`
      SELECT * FROM jobs 
      WHERE deleted_at IS NULL
      ORDER BY created_at DESC 
      LIMIT ? OFFSET ?
    `);
    
    const jobs = jobsStmt.all(limit, offset) as Array<{
      id: string;
      user_id: string;
      book_title: string;
      pdf_storage_path: string;
      voice_storage_path: string | null;
      voice_name: string | null;
      video_id: string | null;
      start_time: number;
      end_time: number;
      status: string;
      progress: number;
      current_section: number;
      total_sections: number;
      audio_storage_path: string | null;
      duration_seconds: number | null;
      error_message: string | null;
      created_at: number;
      updated_at: number;
    }>;

    // Format jobs to match old Supabase format
    const formattedJobs = jobs.map(job => ({
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
      pagination: {
        page,
        limit,
        total: count,
        totalPages: Math.ceil(count / limit),
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
