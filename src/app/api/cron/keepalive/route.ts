import { NextRequest, NextResponse } from "next/server";

const MODAL_TTS_URL = process.env.MODAL_TTS_URL;
const CRON_SECRET = process.env.CRON_SECRET;

// Keepalive endpoint for Modal GPU workers.
// Vercel Hobby: daily at 8am UTC. Upgrade to Pro for higher frequency.
// Can also be called by an external scheduler (e.g. cron-job.org) every 5 min.
// Secured via CRON_SECRET (Vercel injects Authorization: Bearer <CRON_SECRET>).
export async function GET(request: NextRequest) {
  // Verify cron secret (Vercel sends it as Authorization header)
  if (CRON_SECRET) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  if (!MODAL_TTS_URL) {
    return NextResponse.json({ error: "MODAL_TTS_URL not configured" }, { status: 500 });
  }

  const baseUrl = MODAL_TTS_URL.replace("/generate_batch", "");

  try {
    // Health check first
    const healthRes = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(10000),
    });

    if (!healthRes.ok) {
      return NextResponse.json(
        { status: "unhealthy", code: healthRes.status },
        { status: 503 }
      );
    }

    // Trigger warmup for 1 container (minimal cost, prevents cold start)
    const warmupRes = await fetch(`${baseUrl}/warmup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ containers: 1 }),
      signal: AbortSignal.timeout(60000),
    });

    const data = await warmupRes.json().catch(() => ({}));

    return NextResponse.json({
      status: "ok",
      health: "up",
      warmup: warmupRes.ok ? "triggered" : "failed",
      details: data,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[Keepalive] Error:", error);
    return NextResponse.json(
      { status: "error", message: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
