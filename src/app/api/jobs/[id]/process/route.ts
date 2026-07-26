import { NextRequest, NextResponse } from "next/server";
import { runTakehomeWave } from "@/lib/tts/process-job";

export const runtime = "nodejs";
export const maxDuration = 300;

function authorize(request: NextRequest): boolean {
  const secret = process.env.INTERNAL_JOB_SECRET;
  if (!secret) {
    if (process.env.VERCEL || process.env.NODE_ENV === "production") {
      console.error("[Process] INTERNAL_JOB_SECRET not set in production — rejecting");
      return false;
    }
    return true;
  }
  return request.headers.get("x-internal-secret") === secret;
}

/**
 * Internal process kick.
 * Runs a full take-home wave in this invocation (up to ~240s).
 * Never HTTP self-fetches /process (that caused Vercel 508 Loop Detected).
 * When the wave budget ends with work remaining, the job stays `queued`
 * and library/player polling re-kicks via HTTP.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!authorize(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    await runTakehomeWave(id);

    return NextResponse.json({
      jobId: id,
      ok: true,
    });
  } catch (error) {
    console.error("[process] error:", error);
    return NextResponse.json(
      {
        error: "Processing failed. The job will retry automatically shortly.",
      },
      { status: 500 }
    );
  }
}
