import { NextRequest, NextResponse } from "next/server";
import { execute } from "@/lib/turso";
import { handleApiError } from "@/lib/errors";
import { requireOwnedJob } from "@/lib/auth/guard";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { job } = await requireOwnedJob(request, id, "id, user_id, status, job_kind, pdf_storage_path");

    if (job.status === "ready" || job.status === "failed") {
      return NextResponse.json(
        { error: `Cannot cancel a job that is already ${job.status}` },
        { status: 400 }
      );
    }

    // Cancelling clears the lease as well, otherwise a worker mid-wave would
    // keep synthesizing sections the user has already paid to stop.
    await execute(
      `UPDATE jobs SET status = 'cancelled', error_message = 'Cancelled by user',
       processing_lease_token = NULL, lease_expires_at = NULL,
       processing_started_at = NULL, updated_at = unixepoch()
       WHERE id = ?`,
      [id]
    );

    return NextResponse.json({ success: true, message: "Job cancelled" });
  } catch (error) {
    return handleApiError(error);
  }
}
