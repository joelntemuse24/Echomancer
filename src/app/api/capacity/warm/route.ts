import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/errors";
import { requireSession } from "@/lib/auth/guard";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { warmSharedCapacity, type WarmReason } from "@/lib/capacity/warm";

export const runtime = "nodejs";

/**
 * A signed session may ask for one shared warm. The body is a voice id, not
 * a secret. Missing configuration and a busy pool both return 200: nothing
 * here retries into another container.
 */
export async function POST(request: NextRequest) {
  try {
    await requireSession(request);
    await ensureTtsJobColumns();
    const body = (await request.json().catch(() => ({}))) as {
      voiceId?: unknown;
      reason?: unknown;
    };
    const reason: WarmReason = body.reason === "voice" ? "voice" : "create";
    const voiceId = typeof body.voiceId === "string" ? body.voiceId : null;
    const result = await warmSharedCapacity({ reason, voiceId });
    return NextResponse.json({ ok: true, posted: result.posted });
  } catch (err) {
    return handleApiError(err);
  }
}
