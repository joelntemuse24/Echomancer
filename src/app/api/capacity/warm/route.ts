import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/errors";
import { SessionRequiredError } from "@/lib/auth/guard";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { warmSharedCapacity, type WarmReason } from "@/lib/capacity/warm";

export const runtime = "nodejs";

/**
 * A browser that already holds `ec_session` may ask for one shared warm.
 * That cookie is the anonymous guest from the first page, or a signed-in
 * user. The proxy also mints a session onto `x-ec-session` for a request
 * that arrived with no cookie, so the first upload has an owner. This route
 * does not accept that just-minted header: a cookieless POST must not claim
 * a warm or start a container. The body is a voice id, not a secret.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await verifySessionToken(
      request.cookies.get(SESSION_COOKIE)?.value
    );
    if (!session) throw new SessionRequiredError();
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
