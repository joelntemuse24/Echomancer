import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getUserById, isGoogleOAuthConfigured } from "@/lib/auth/google";
import { isEmailLoginConfigured } from "@/lib/auth/email-login";
import {
  isDurableUserId,
  resolveSessionUserId,
} from "@/lib/auth/session";
import { isMarkupOperator } from "@/lib/operator/tools";

export const runtime = "nodejs";

/**
 * Who is at the keyboard, for the header.
 *
 * Home and the dashboard used to await this on the server before sending
 * any HTML, so a click sat on the previous screen until Turso answered.
 * The shell renders without it. Signed-out visitors never touch the user
 * table: the session cookie is verified locally. A signed-in visitor is a
 * user-row read. `key` changes when the session does, so the tab can drop
 * another person's library. A database error is 503 and must not be stored
 * as signed-out. `markup` is the operator Voice text link; the markup page
 * still 404s on its own.
 */
export async function GET(request: NextRequest) {
  const googleEnabled = isGoogleOAuthConfigured();
  const emailEnabled = isEmailLoginConfigured();
  const userId = await resolveSessionUserId(request);
  if (!userId) {
    return json({
      signedIn: false,
      googleEnabled,
      emailEnabled,
      markup: false,
      key: viewerKey("none"),
    });
  }
  const key = viewerKey(userId);
  if (!isDurableUserId(userId)) {
    return json({
      signedIn: false,
      googleEnabled,
      emailEnabled,
      markup: await isMarkupOperator(userId),
      key,
    });
  }
  try {
    const user = await getUserById(userId);
    return json({
      signedIn: true,
      googleEnabled,
      emailEnabled,
      name: user?.name ?? null,
      email: user?.email ?? null,
      image: user?.image ?? null,
      markup: await isMarkupOperator(userId),
      key,
    });
  } catch {
    return NextResponse.json(
      { error: "Couldn't confirm this session." },
      { status: 503, headers: { "Cache-Control": "private, no-store" } }
    );
  }
}

function viewerKey(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 16);
}

function json(body: unknown): NextResponse {
  return NextResponse.json(body, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
