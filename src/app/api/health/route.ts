import { NextResponse } from "next/server";
import { query } from "@/lib/turso";
import { isR2Configured } from "@/lib/r2-storage";

export async function GET() {
  const checks: Record<string, boolean | string> = {
    turso: false,
    r2: isR2Configured(),
    modal: false,
  };

  // Check Turso
  try {
    await query("SELECT 1");
    checks.turso = true;
  } catch (error) {
    checks.turso = error instanceof Error ? error.message : "Failed";
  }

  // Check Modal (opt-in only — avoids pinging Modal on every health check)
  const modalUrl = process.env.MODAL_TTS_URL;
  if (modalUrl && process.env.MODAL_WARMUP_ENABLED === "true") {
    try {
      const baseUrl = modalUrl.replace("/generate_batch", "");
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`${baseUrl}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      checks.modal = response.ok ? "warm" : "error";
    } catch {
      checks.modal = "cold";
    }
  }

  const allHealthy =
    checks.turso === true &&
    checks.r2 === true &&
    checks.modal === "warm";

  return NextResponse.json({
    status: allHealthy ? "healthy" : "degraded",
    checks,
    timestamp: new Date().toISOString(),
  }, {
    status: allHealthy ? 200 : 503,
  });
}
