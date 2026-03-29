import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { createJobSchema, paginationSchema } from "@/lib/validation";
import { AppError, handleApiError } from "@/lib/errors";
import { randomUUID } from "crypto";
import { generateAudiobookV2 } from "@/lib/generate-audiobook-v2";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = createJobSchema.parse(body);

    const supabase = createServerClient();
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
        voice_storage_path: parsed.voiceStoragePath || null,
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
    generateAudiobookV2({
      jobId,
      pdfStoragePath: parsed.pdfStoragePath,
      voiceStoragePath: parsed.voiceStoragePath || null,
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
