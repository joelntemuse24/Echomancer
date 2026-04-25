import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { cancelJobGeneration } from "@/lib/generate-audiobook-v2";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Check if job exists and can be cancelled
    const stmt = db.prepare(`SELECT status FROM jobs WHERE id = ? AND deleted_at IS NULL`);
    const job = stmt.get(id) as { status: string } | undefined;

    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    if (job.status === "ready" || job.status === "failed") {
      return NextResponse.json(
        { error: `Cannot cancel a job that is already ${job.status}` },
        { status: 400 }
      );
    }

    // Abort in-flight Modal request if generation is running
    const wasGenerating = cancelJobGeneration(id);
    console.log(`[Cancel] Job ${id}: wasGenerating=${wasGenerating}`);

    // Update job to failed with cancelled error message
    const updateStmt = db.prepare(`
      UPDATE jobs 
      SET status = 'failed', 
          error_message = 'Cancelled by user',
          updated_at = unixepoch()
      WHERE id = ?
    `);
    updateStmt.run(id);

    return NextResponse.json({ success: true, message: "Job cancelled" });
  } catch (error) {
    console.error("Cancel job error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
