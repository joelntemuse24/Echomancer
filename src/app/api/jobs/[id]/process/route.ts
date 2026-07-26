import { NextRequest, NextResponse } from "next/server";
import {
  processTakehomeTick,
  chainTakehomeContinue,
} from "@/lib/tts/process-job";

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
 * Manual / internal process kick.
 * Runs one tick, then continues in-process via after() — never HTTP self-fetches
 * (that caused Vercel 508 Loop Detected in production).
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
    const result = await processTakehomeTick(id);

    if (!result.done) {
      chainTakehomeContinue(id);
    }

    return NextResponse.json({
      jobId: id,
      done: result.done,
      nextIndex: result.nextIndex,
      total: result.total,
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
