import { NextRequest, NextResponse } from "next/server";
import {
  EmailLoginNotConfiguredError,
  isEmailLoginConfigured,
  normalizeEmail,
  requestEmailLogin,
  safeNextPath,
  sha256Hex,
} from "@/lib/auth/email-login";
import { AppError, handleApiError } from "@/lib/errors";
import {
  clientIp,
  createRateLimiter,
  rateLimitIdentity,
} from "@/lib/rate-limit";

export const runtime = "nodejs";

/** Each request sends an email, so both limiters fail closed. */
const perAddressLimit = createRateLimiter(3, 10 * 60_000, { onError: "closed" });
const perIpLimit = createRateLimiter(20, 60 * 60_000, { onError: "closed" });

/**
 * Ask for a sign-in link. The answer never says whether the address already has
 * an account, so this cannot be used to probe who is registered.
 */
export async function POST(request: NextRequest) {
  try {
    if (!isEmailLoginConfigured()) throw new EmailLoginNotConfiguredError();

    if (!request.headers.get("content-type")?.includes("application/json")) {
      throw new AppError(
        "UNSUPPORTED_MEDIA_TYPE",
        "Send the address as JSON.",
        415
      );
    }
    const body = (await request.json().catch(() => null)) as {
      email?: unknown;
      next?: unknown;
    } | null;

    const email = normalizeEmail(body?.email);
    if (!email) {
      throw new AppError("INVALID_EMAIL", "Enter a valid email address.", 400);
    }

    const ipAllowed = await perIpLimit(
      await rateLimitIdentity({ ip: clientIp(request) })
    );
    const addressAllowed = await perAddressLimit(await sha256Hex(email));
    if (!ipAllowed || !addressAllowed) {
      throw new AppError(
        "RATE_LIMITED",
        "Too many sign-in emails. Wait a few minutes and try again.",
        429
      );
    }

    await requestEmailLogin({
      email,
      next: safeNextPath(body?.next),
      requestOrigin: request.nextUrl.origin,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
