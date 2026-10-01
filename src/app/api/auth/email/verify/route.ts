import { NextRequest, NextResponse } from "next/server";
import {
  completeEmailSignIn,
  safeNextPath,
} from "@/lib/auth/email-login";
import { attachSessionCookie, readSession } from "@/lib/auth/session";
import { handleApiError } from "@/lib/errors";

export const runtime = "nodejs";

function trustedHosts(request: NextRequest): Set<string> {
  const hosts = new Set([request.nextUrl.host]);
  const configured =
    process.env.AUTH_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) {
    try {
      hosts.add(new URL(configured).host);
    } catch {
      /* ignore a malformed override */
    }
  }
  return hosts;
}

/**
 * Only our own confirm page may submit a token. Without this a foreign site
 * could post the attacker's token from the victim's browser, signing the victim
 * into the attacker's account and moving their anonymous library onto it.
 */
function isSameOriginSubmit(request: NextRequest): boolean {
  // Browsers set this themselves and pages cannot forge it. It is also the
  // reliable signal: a form post from a page with a strict referrer policy
  // carries `Origin: null`.
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";

  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return trustedHosts(request).has(new URL(origin).host);
  } catch {
    return false;
  }
}

function redirect(request: NextRequest, path: string): NextResponse {
  const response = NextResponse.redirect(new URL(path, request.url), 303);
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function POST(request: NextRequest) {
  try {
    if (!isSameOriginSubmit(request)) {
      return redirect(request, "/sign-in?error=invalid");
    }

    const form = await request.formData().catch(() => null);
    const next = safeNextPath(form?.get("next"));

    const existing = await readSession(request);
    const result = await completeEmailSignIn({
      token: form?.get("token"),
      anonUserId: existing?.userId ?? null,
    });
    if (!result) {
      const retry = new URLSearchParams({ error: "expired" });
      retry.set("next", next);
      return redirect(request, `/sign-in?${retry.toString()}`);
    }

    return attachSessionCookie(redirect(request, next), result.session);
  } catch (error) {
    return handleApiError(error);
  }
}
