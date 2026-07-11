import { NextRequest, NextResponse } from "next/server";
import { resolveTtsRoute } from "@/lib/tts-config";

// Simple in-memory cooldown: track last warmup per IP to prevent abuse
const lastWarmupByIp = new Map<string, number>();
const WARMUP_COOLDOWN_MS = 30_000; // 30 seconds

export async function POST(request: NextRequest) {
  try {
    // Rate-limit by IP (best-effort, resets on serverless cold start)
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const body = await request.json().catch(() => ({}));
    const purpose = body.purpose === "audiobook" ? "audiobook" : "preview";
    const route = resolveTtsRoute(purpose, {
      charCount: Number.isFinite(body.charCount) ? body.charCount : undefined,
      paragraphCount: Number.isFinite(body.paragraphCount)
        ? body.paragraphCount
        : undefined,
    });
    const cooldownKey = `${ip}:${route.variant}`;
    const now = Date.now();
    const lastWarmup = lastWarmupByIp.get(cooldownKey) ?? 0;
    if (now - lastWarmup < WARMUP_COOLDOWN_MS) {
      return NextResponse.json(
        { status: "cooldown", message: "Warmup requested recently" },
        { status: 429 }
      );
    }
    const modalBatchUrl = route.batchUrl;
    if (!modalBatchUrl) {
      return NextResponse.json(
        { error: "Modal TTS URL not configured" },
        { status: 500 }
      );
    }
    lastWarmupByIp.set(cooldownKey, now);

    const baseUrl = modalBatchUrl.replace("/generate_batch", "");
    const containers = Math.min(Math.max(1, body.containers ?? 2), 5);

    // Fire-and-forget to Modal — we don't wait for containers to fully load
    // because that can take 30-60s. We just trigger the warmup and return.
    fetch(`${baseUrl}/warmup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-TTS-Trigger-Secret":
          process.env.TTS_TRIGGER_SECRET ?? process.env.WEBHOOK_SECRET ?? "",
      },
      body: JSON.stringify({ containers }),
    }).catch((err) => {
      console.log("[Warmup] Background Modal call failed (non-critical):", err);
    });

    return NextResponse.json({
      status: "triggered",
      containers_requested: containers,
      variant: route.variant,
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
