import { NextRequest, NextResponse } from "next/server";
import { updateJob } from "@/lib/turso/jobs";
import { queryOne } from "@/lib/turso";
import { z } from "zod";

const webhookSchema = z.object({
  job_id: z.string(),
  status: z.enum(["queued", "processing", "ready", "failed"]),
  progress: z.number().optional(),
  current_section: z.number().optional(),
  total_sections: z.number().optional(),
  audio_storage_path: z.string().optional().nullable(),
  duration_seconds: z.number().optional().nullable(),
  error_message: z.string().optional().nullable(),
});

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const authHeader = request.headers.get("x-webhook-secret");
    // Require webhook secret in production; allow unauthenticated in dev only
    if (WEBHOOK_SECRET) {
      if (authHeader !== WEBHOOK_SECRET) {
        console.warn(`[Webhook] Unauthorized attempt for job ${id}. Header present: ${Boolean(authHeader)}`);
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    const body = await request.json();
    const parsed = webhookSchema.parse(body);

    if (parsed.job_id !== id) {
      return NextResponse.json({ error: "Job ID mismatch" }, { status: 400 });
    }

    const job = await queryOne<{ id: string; status: string; progress: number | null }>(
      "SELECT id, status, progress FROM jobs WHERE id = ?",
      [id]
    );
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    // Monotonic state guards: never regress terminal states or decrease progress
    const currentStatus = job.status;
    const currentProgress = job.progress ?? 0;

    // Terminal states are final — ignore any late updates
    if (currentStatus === "ready" || currentStatus === "failed") {
      console.log(`[Webhook] Job ${id} already terminal (${currentStatus}), ignoring update`);
      return NextResponse.json({ success: true, ignored: true });
    }

    // Never overwrite ready/failed with processing
    if ((currentStatus === "ready" || currentStatus === "failed") && parsed.status === "processing") {
      console.log(`[Webhook] Job ${id} ignoring processing update because already ${currentStatus}`);
      return NextResponse.json({ success: true, ignored: true });
    }

    const updateData: Parameters<typeof updateJob>[1] = {
      status: parsed.status,
    };

    // Never decrease progress
    if (parsed.progress !== undefined && parsed.progress >= currentProgress) {
      updateData.progress = parsed.progress;
    } else if (parsed.progress !== undefined) {
      console.log(`[Webhook] Job ${id} ignoring progress ${parsed.progress} < current ${currentProgress}`);
    }
    if (parsed.current_section !== undefined) {
      updateData.current_section = parsed.current_section;
    }
    if (parsed.total_sections !== undefined) {
      updateData.total_sections = parsed.total_sections;
    }
    if (parsed.audio_storage_path !== undefined) {
      updateData.audio_storage_path = parsed.audio_storage_path ?? undefined;
    }
    if (parsed.duration_seconds !== undefined) {
      updateData.duration_seconds = parsed.duration_seconds ?? undefined;
    }
    if (parsed.error_message !== undefined) {
      updateData.error_message = parsed.error_message;
    }

    await updateJob(id, updateData);

    console.log(`[Webhook] Job ${id} updated: status=${parsed.status}, progress=${parsed.progress}`);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Webhook error:", error);
    return NextResponse.json({ error: "Invalid webhook payload" }, { status: 400 });
  }
}
