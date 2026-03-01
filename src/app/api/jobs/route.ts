import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { createJobSchema, paginationSchema } from "@/lib/validation";
import { AppError, handleApiError } from "@/lib/errors";
import { randomUUID } from "crypto";

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
        user_id: "anonymous", // Replace with auth user ID when Clerk is configured
        book_title: parsed.bookTitle,
        voice_name: parsed.voiceName,
        status: "queued",
        progress: 0,
        pdf_storage_path: parsed.pdfStoragePath,
        voice_storage_path: parsed.voiceStoragePath || "",
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

    // Trigger the background job via Trigger.dev (gracefully skipped if not configured)
    try {
      const triggerUrl = process.env.TRIGGER_API_URL;
      const triggerApiKey = process.env.TRIGGER_SECRET_KEY;

      if (triggerUrl && triggerApiKey) {
        const triggerRes = await fetch(`${triggerUrl}/api/v1/tasks/generate-audiobook/trigger`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${triggerApiKey}`,
          },
          body: JSON.stringify({
            payload: {
              jobId,
              pdfStoragePath: parsed.pdfStoragePath,
              voiceStoragePath: parsed.voiceStoragePath || null,
              videoId: parsed.videoId || null,
              startTime: parsed.startTime,
              endTime: parsed.endTime,
            },
          }),
        });

        if (triggerRes.ok) {
          const triggerData = await triggerRes.json();
          await supabase
            .from("jobs")
            .update({ trigger_task_id: triggerData.id || null })
            .eq("id", jobId);
        } else {
          console.warn("[Trigger.dev] Task dispatch failed:", await triggerRes.text());
        }
      }
    } catch (triggerError) {
      console.warn("[Trigger.dev] Not configured or unreachable:", triggerError);
    }

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
