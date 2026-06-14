import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Basic API protection middleware.
 *
 * When API_SECRET is set, all mutating API routes (/api/jobs POST, /api/pdf/upload, etc.)
 * require an `x-api-key` header. This prevents unauthenticated users from
 * creating jobs and racking up Modal costs.
 *
 * For a full auth solution (user accounts, session management), consider
 * adding Clerk or NextAuth in a future iteration.
 */
export function middleware(request: NextRequest) {
  const apiSecret = process.env.API_SECRET;

  // If no API_SECRET configured, allow all requests (dev mode)
  if (!apiSecret) return NextResponse.next();

  // Only protect mutating API endpoints
  const isProtectedRoute =
    request.nextUrl.pathname.startsWith("/api/jobs") ||
    request.nextUrl.pathname.startsWith("/api/pdf/") ||
    request.nextUrl.pathname.startsWith("/api/audio/") ||
    request.nextUrl.pathname.startsWith("/api/voices") ||
    request.nextUrl.pathname.startsWith("/api/voice/");

  // Allow GET requests (reading) and webhooks
  const isReadOnly = request.method === "GET";
  const isWebhook = request.nextUrl.pathname.includes("/webhook");
  const isCron = request.nextUrl.pathname.startsWith("/api/cron/");

  if (!isProtectedRoute || isReadOnly || isWebhook || isCron) {
    return NextResponse.next();
  }

  // Check API key
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== apiSecret) {
    return NextResponse.json(
      { error: "Unauthorized. Set x-api-key header." },
      { status: 401 }
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
