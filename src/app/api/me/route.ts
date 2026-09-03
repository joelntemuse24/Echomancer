import { NextRequest, NextResponse } from "next/server";
import { getUserById, isGoogleOAuthConfigured } from "@/lib/auth/google";
import {
  isDurableUserId,
  resolveSessionUserId,
} from "@/lib/auth/session";
import { handleApiError } from "@/lib/errors";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await ensureTtsJobColumns();
    const userId = await resolveSessionUserId(request);
    const googleEnabled = isGoogleOAuthConfigured();

    if (!userId || !isDurableUserId(userId)) {
      return NextResponse.json({ signedIn: false, googleEnabled });
    }

    const user = await getUserById(userId);
    return NextResponse.json({
      signedIn: true,
      googleEnabled,
      name: user?.name ?? null,
      email: user?.email ?? null,
      image: user?.image ?? null,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
