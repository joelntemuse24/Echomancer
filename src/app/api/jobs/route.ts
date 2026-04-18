import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
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

    const supabase = createServerClient();

    // Deduplication: check if a "ready" job already exists with same PDF+voice+clip
    const { data: existingJobs } = await supabase
      .from("jobs")
      .select("id, status, audio_storage_path")
      .eq("pdf_storage_path", parsed.pdfStoragePath)
      .eq("voice_storage_path", (parsed.voiceStoragePath || "").split(",").map(p => p.trim()).sort().join(","))
      .eq("start_time", parsed.startTime)
      .eq("end_time", parsed.endTime)
      .eq("status", "ready")
      .limit(1);

    if (existingJobs && existingJobs.length > 0) {
      const existing = existingJobs[0]!;
      return NextResponse.json({
        jobId: existing.id,
        status: "ready",
        message: "This audiobook already exists — returning existing job.",
        duplicate: true,
      });
    }

    const jobId = randomUUID();

    const { data: job, error: insertError } = await supabase
      .from("jobs")
      .insert({
        id: jobId,
        user_id: "anonymous",
        book_title: parsed.bookTitle,
        voice_name: parsed.voiceName,
        status: "queued",
        progress: 0,
        pdf_storage_path: parsed.pdfStoragePath,
        voice_storage_path: parsed.voiceStoragePath ? parsed.voiceStoragePath.split(",").map(p => p.trim()).sort().join(",") : null,
        video_id: parsed.videoId || null,
        start_time: parsed.startTime,
        end_time: parsed.endTime,
        error: null,
        trigger_task_id: null,
      })
      .select()
      .single();

    if (insertError) {
      throw new AppError("DB_INSERT_FAILED", `Failed to create job: ${insertError.message}`, 500);
    }

    // Fire and forget — generation runs in the background
    // The function updates job status in Supabase as it progresses
    
    // Support multi-reference: voiceStoragePath can be comma-separated paths
    const voicePaths = parsed.voiceStoragePath 
      ? parsed.voiceStoragePath.split(',').filter(p => p.trim())
      : [];
    
    generateAudiobookV2({
      jobId,
      pdfStoragePath: parsed.pdfStoragePath,
      voiceStoragePath: voicePaths[0] || null, // Primary voice path
      voiceStoragePaths: voicePaths.length > 1 ? voicePaths : undefined, // Multi-reference
      videoId: parsed.videoId || null,
      startTime: parsed.startTime,
      endTime: parsed.endTime,
    }).catch((err) => {
      console.error(`[Job ${jobId}] Unhandled error:`, err);
    });

    return NextResponse.json({
      jobId: job.id,
      status: job.status,
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
    const supabase = createServerClient();

    const { data: jobs, error, count } = await supabase
      .from("jobs")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      throw new AppError("DB_QUERY_FAILED", error.message, 500);
    }

    return NextResponse.json({
      jobs,
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
