import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = createServerClient();

    // First check if job exists and can be cancelled
    const { data: job, error: fetchError } = await supabase
      .from("jobs")
      .select("status")
      .eq("id", id)
      .single();

    if (fetchError) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    if (job.status === "ready" || job.status === "failed") {
      return NextResponse.json(
        { error: `Cannot cancel a job that is already ${job.status}` },
        { status: 400 }
      );
    }

    // Update job to failed with cancelled error message
    const { error: updateError } = await supabase
      .from("jobs")
      .update({
        status: "failed",
        error: "Cancelled by user",
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (updateError) {
      return NextResponse.json(
        { error: "Failed to cancel job" },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, message: "Job cancelled" });
  } catch (error) {
    console.error("Cancel job error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
