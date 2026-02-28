import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { randomUUID } from "crypto";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      pdfStoragePath,
      bookTitle,
      videoId,
      voiceStoragePath,
      voiceName,
      startTime,
      endTime,
    } = body;

    if (!pdfStoragePath) {
      return NextResponse.json({ error: "PDF storage path is required" }, { status: 400 });
    }

    if (!voiceStoragePath && !videoId) {
      return NextResponse.json(
        { error: "Either a voice storage path or YouTube video ID is required" },
        { status: 400 }
      );
    }

    const supabase = createServerClient();
    const jobId = randomUUID();

    // Create job record in Supabase
    const { data: job, error: insertError } = await supabase
      .from("jobs")
      .insert({
        id: jobId,
        user_id: "anonymous", // TODO: Replace with Clerk user ID
        book_title: bookTitle || "Untitled",
        voice_name: voiceName || "Custom Voice",
        status: "queued",
        progress: 0,
        pdf_storage_path: pdfStoragePath,
        voice_storage_path: voiceStoragePath || "",
        video_id: videoId || null,
        start_time: startTime || 0,
        end_time: endTime || 60,
        error: null,
        trigger_task_id: null,
      })
      .select()
      .single();

    if (insertError) {
      console.error("Job creation error:", insertError);
      return NextResponse.json(
        { error: "Failed to create job", details: insertError.message },
        { status: 500 }
      );
    }

    // Trigger the background job via Trigger.dev
    // In production, this calls Trigger.dev's API to start the task
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
              pdfStoragePath,
              voiceStoragePath: voiceStoragePath || null,
              videoId: videoId || null,
              startTime: startTime || 0,
              endTime: endTime || 60,
            },
          }),
        });

        if (triggerRes.ok) {
          const triggerData = await triggerRes.json();
          // Update job with trigger task ID
          await supabase
            .from("jobs")
            .update({ trigger_task_id: triggerData.id || null })
            .eq("id", jobId);
        } else {
          console.warn("Trigger.dev call failed, job will need manual processing:", await triggerRes.text());
        }
      } else {
        console.warn("Trigger.dev not configured. Job created but won't be processed automatically.");
      }
    } catch (triggerError) {
      console.warn("Failed to trigger background job:", triggerError);
      // Job is still created, just won't be processed until Trigger.dev is configured
    }

    return NextResponse.json({
      jobId: job.id,
      status: job.status,
      message: "Job created successfully",
    });
  } catch (error) {
    console.error("Job creation error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function GET() {
  try {
    const supabase = createServerClient();

    const { data: jobs, error } = await supabase
      .from("jobs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ jobs });
  } catch (error) {
    console.error("Jobs fetch error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
