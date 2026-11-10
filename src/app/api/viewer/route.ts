import { NextRequest, NextResponse } from "next/server";
import { getUserById, isGoogleOAuthConfigured } from "@/lib/auth/google";
import { isEmailLoginConfigured } from "@/lib/auth/email-login";
import {
  isDurableUserId,
  resolveSessionUserId,
} from "@/lib/auth/session";
import {
  operatorEmailAllowlist,
  operatorToolsEnabled,
  operatorUserIdAllowlist,
} from "@/lib/operator/tools";

export const runtime = "nodejs";

/**
 * Who is at the keyboard, for the header.
 *
 * Home and the dashboard used to await this on the server before sending
 * any HTML, so a click sat on the previous screen until Turso answered.
 * The shell renders without it. Signed-out visitors never touch the
 * database: the session cookie is verified locally. A signed-in visitor
 * is one primary-key read. `markup` is the operator Voice text link;
 * everyone else gets false, and the markup page still 404s on its own.
 */
export async function GET(request: NextRequest) {
  const googleEnabled = isGoogleOAuthConfigured();
  const emailEnabled = isEmailLoginConfigured();
  const userId = await resolveSessionUserId(request);
  if (!userId || !isDurableUserId(userId)) {
    return json({
      signedIn: false,
      googleEnabled,
      emailEnabled,
      markup: false,
    });
  }
  try {
    const user = await getUserById(userId);
    if (!user) {
      return json({
        signedIn: false,
        googleEnabled,
        emailEnabled,
        markup: false,
      });
    }
    return json({
      signedIn: true,
      googleEnabled,
      emailEnabled,
      name: user.name ?? null,
      email: user.email ?? null,
      image: user.image ?? null,
      markup: markupAllowed(user.id, user.email, user.email_verified),
    });
  } catch {
    return json({
      signedIn: false,
      googleEnabled,
      emailEnabled,
      markup: false,
    });
  }
}

function markupAllowed(
  userId: string,
  email: string | null,
  emailVerified: number | null
): boolean {
  if (!operatorToolsEnabled()) return false;
  if (operatorUserIdAllowlist().includes(userId)) return true;
  if (emailVerified !== 1) return false;
  const normalized = email?.trim().toLowerCase() ?? "";
  return normalized.length > 0 && operatorEmailAllowlist().includes(normalized);
}

function json(body: unknown): NextResponse {
  return NextResponse.json(body, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
