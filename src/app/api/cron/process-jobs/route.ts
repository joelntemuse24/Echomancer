import { NextRequest, NextResponse } from "next/server";
import { drainTakehomeQueue } from "@/lib/tts/process-job";
import { authorizeCron } from "@/lib/jobs/worker-auth";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * The durable side of take-home generation.
 *
 * Scheduled in `vercel.json`. Because progress lives in the `jobs` row, this
 * route needs no state of its own: it releases leases abandoned by crashed
 * workers, then advances the oldest queued jobs until the invocation's budget
 * runs out. Nobody has to be watching the page for a book to finish.
 *
 * Concurrent runs are safe — each job is lease-claimed before any synthesis.
 */
export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const { picked } = await drainTakehomeQueue();
    return NextResponse.json({
      ok: true,
      picked,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    console.error("[cron/process-jobs] failed:", error);
    return NextResponse.json(
      { ok: false, error: "Queue drain failed" },
      { status: 500 }
    );
  }
}
