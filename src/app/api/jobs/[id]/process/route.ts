import { NextRequest, NextResponse } from "next/server";
import {
  processTakehomeTick,
  scheduleTakehomeContinue,
} from "@/lib/tts/process-job";

export const runtime = "nodejs";
export const maxDuration = 300;

function authorize(request: NextRequest): boolean {
  const secret = process.env.INTERNAL_JOB_SECRET;
  if (!secret) {
    // Dev: allow without secret
    return process.env.NODE_ENV !== "production";
  }
  return request.headers.get("x-internal-secret") === secret;
}

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
      // Chain next tick (don't block response too long)
      scheduleTakehomeContinue(id);
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
        error: error instanceof Error ? error.message : "Process failed",
      },
      { status: 500 }
    );
  }
}
