import { NextRequest, NextResponse } from "next/server";
import { runTakehomeWave } from "@/lib/tts/process-job";
import { authorizeInternalWorker } from "@/lib/jobs/worker-auth";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Advance one take-home job for as much of this invocation as the budget allows.
 *
 * Never HTTP self-calls: fetching this same route from inside itself produced
 * Vercel 508 "Loop Detected". If the wave ends with work remaining, the job goes
 * back to `queued` and the cron drain (or the next call here) resumes it.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!authorizeInternalWorker(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  try {
    await runTakehomeWave(id);
    return NextResponse.json({ jobId: id, ok: true });
  } catch (error) {
    console.error(`[process ${id}] error:`, error);
    return NextResponse.json(
      { error: "Processing failed. The job will retry automatically shortly." },
      { status: 500 }
    );
  }
}
