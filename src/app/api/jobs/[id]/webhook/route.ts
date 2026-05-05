import { NextRequest, NextResponse } from "next/server";
import { updateJob } from "@/lib/turso/jobs";
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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const parsed = webhookSchema.parse(body);

    if (parsed.job_id !== id) {
      return NextResponse.json({ error: "Job ID mismatch" }, { status: 400 });
    }

    const updateData: Parameters<typeof updateJob>[1] = {
      status: parsed.status,
    };

    if (parsed.progress !== undefined) {
      updateData.progress = parsed.progress;
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
