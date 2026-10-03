/**
 * POST /api/log — pick-time failures from the browser.
 *
 * A Drive pick that fails on a phone used to be silent: no upload, no
 * error, nothing to debug. The pick handlers now report those failures
 * here (best effort) so they land in the server log next to the upload
 * routes. Bounded, tag-allowlisted, and rate-limited; never mints a
 * session and never returns anything but 204.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { clientIp, createRateLimiter, rateLimitIdentity } from "@/lib/rate-limit";

export const runtime = "nodejs";

const clientLogRateLimit = createRateLimiter(20, 10 * 60_000, {
  onError: "open",
});

const logSchema = z.object({
  tag: z.enum(["book-upload", "clone-sample"]),
  message: z.string().trim().min(1).max(500),
  detail: z.string().trim().max(300).optional(),
});

/** Newlines and other control characters never reach the server log (log injection). */
function sanitizeLogLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s{2,}/g, " ").trim();
}

export async function POST(request: NextRequest) {
  try {
    if (
      !(await clientLogRateLimit(
        await rateLimitIdentity({ ip: clientIp(request) })
      ))
    ) {
      return new NextResponse(null, { status: 204 });
    }

    const raw = await request.json().catch(() => null);
    const parsed = logSchema.safeParse(raw);
    if (!parsed.success) {
      return new NextResponse(null, { status: 204 });
    }

    const message = sanitizeLogLine(parsed.data.message);
    if (!message) {
      return new NextResponse(null, { status: 204 });
    }
    const detail = parsed.data.detail
      ? sanitizeLogLine(parsed.data.detail)
      : "";

    console.warn(
      `[client:${parsed.data.tag}] ${message}` +
        (detail ? ` — ${detail}` : "")
    );
    return new NextResponse(null, { status: 204 });
  } catch {
    return new NextResponse(null, { status: 204 });
  }
}
