import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_HEADER,
  attachSessionCookie,
  isSessionConfigured,
  mintSession,
  readSession,
} from "@/lib/auth/session";

/**
 * Give every signed-out visitor a signed anonymous session before they reach
 * a route. Existing `user_*` cookies are left alone.
 *
 * Route handlers re-verify via `resolveSessionUserId()`, so this is purely
 * about *issuing* the cookie early enough that the first upload already has
 * an owner. The header is always overwritten — a client cannot smuggle in an
 * identity of its own.
 */
export async function proxy(request: NextRequest) {
  if (!isSessionConfigured()) return NextResponse.next();

  const existing = await readSession(request);
  const session = existing ?? (await mintSession());

  const headers = new Headers(request.headers);
  headers.set(SESSION_HEADER, session.token);

  const response = NextResponse.next({ request: { headers } });
  if (!existing) attachSessionCookie(response, session);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
