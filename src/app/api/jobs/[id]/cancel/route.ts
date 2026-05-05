import { NextRequest, NextResponse } from "next/server";
import { execute, queryOne } from "@/lib/turso";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const job = await queryOne<{ status: string }>(
      `SELECT status FROM jobs WHERE id = ? AND deleted_at IS NULL`,
      [id]
    );

    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    if (job.status === "ready" || job.status === "failed") {
      return NextResponse.json(
        { error: `Cannot cancel a job that is already ${job.status}` },
        { status: 400 }
      );
    }

    await execute(
      `UPDATE jobs SET status = 'failed', error_message = 'Cancelled by user', updated_at = unixepoch() WHERE id = ?`,
      [id]
    );

    return NextResponse.json({ success: true, message: "Job cancelled" });
  } catch (error) {
    console.error("Cancel job error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
