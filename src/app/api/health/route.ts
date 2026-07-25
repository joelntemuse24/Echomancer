import { NextResponse } from "next/server";
import { query } from "@/lib/turso";
import { isR2Configured } from "@/lib/r2-storage";

export async function GET() {
  const checks: Record<string, boolean | string> = {
    turso: false,
    r2: isR2Configured(),
    openrouter: false,
  };

  // Check Turso
  try {
    await query("SELECT 1");
    checks.turso = true;
  } catch (error) {
    checks.turso = error instanceof Error ? error.message : "Failed";
  }

  // Check OpenRouter
  const orKey = process.env.OPENROUTER_API_KEY;
  if (orKey) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const response = await fetch("https://openrouter.ai/api/v1/models", {
        headers: { Authorization: `Bearer ${orKey}` },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      checks.openrouter = response.ok ? "ok" : "error";
    } catch {
      checks.openrouter = "unreachable";
    }
  }

  const allHealthy =
    checks.turso === true &&
    checks.r2 === true;

  return NextResponse.json({
    status: allHealthy ? "healthy" : "degraded",
    checks,
    timestamp: new Date().toISOString(),
  }, {
    status: allHealthy ? 200 : 503,
  });
}
