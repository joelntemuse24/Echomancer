import { NextResponse } from "next/server";
import { query } from "@/lib/turso";
import { isR2Configured } from "@/lib/r2-storage";

export async function GET() {
  // M9: Don't leak per-service details or call external APIs
  let tursoOk = false;
  try {
    await query("SELECT 1");
    tursoOk = true;
  } catch {
    tursoOk = false;
  }

  const r2Ok = isR2Configured();
  const allHealthy = tursoOk && r2Ok;

  return NextResponse.json(
    { status: allHealthy ? "healthy" : "degraded" },
    { status: allHealthy ? 200 : 503 }
  );
}
