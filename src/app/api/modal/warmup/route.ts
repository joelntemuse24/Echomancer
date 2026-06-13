import { NextRequest, NextResponse } from "next/server";

const MODAL_TTS_URL = process.env.MODAL_TTS_URL;

// Simple in-memory cooldown: track last warmup per IP to prevent abuse
const lastWarmupByIp = new Map<string, number>();
const WARMUP_COOLDOWN_MS = 30_000; // 30 seconds

export async function POST(request: NextRequest) {
  try {
    if (process.env.MODAL_WARMUP_ENABLED !== "true") {
      return NextResponse.json({
        status: "disabled",
        message: "Modal warmup disabled (set MODAL_WARMUP_ENABLED=true to enable)",
      });
    }

    // Rate-limit by IP (best-effort, resets on serverless cold start)
    const ip = request.headers.get("x-forwarded-for") || "unknown";
    const now = Date.now();
    const lastWarmup = lastWarmupByIp.get(ip) ?? 0;
    if (now - lastWarmup < WARMUP_COOLDOWN_MS) {
      return NextResponse.json(
        { status: "cooldown", message: "Warmup requested recently" },
        { status: 429 }
      );
    }
    lastWarmupByIp.set(ip, now);

    if (!MODAL_TTS_URL) {
      return NextResponse.json(
        { error: "Modal TTS URL not configured" },
        { status: 500 }
      );
    }

    const baseUrl = MODAL_TTS_URL.replace("/generate_batch", "");
    const body = await request.json().catch(() => ({}));
    const containers = Math.min(Math.max(1, body.containers ?? 4), 4);

    // Fire-and-forget to Modal — we don't wait for containers to fully load
    // because that can take 30-60s. We just trigger the warmup and return.
    fetch(`${baseUrl}/warmup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ containers }),
    }).catch((err) => {
      console.log("[Warmup] Background Modal call failed (non-critical):", err);
    });

    return NextResponse.json({
      status: "triggered",
      containers_requested: containers,
      message: "Warmup triggered in background",
    });
  } catch (error) {
    console.error("[Warmup API] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
