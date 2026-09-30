/**
 * YouTube search for the clone screen. The Data API key stays on the server.
 */

import { NextRequest, NextResponse } from "next/server";
import { handleApiError, AppError } from "@/lib/errors";
import { requireSession } from "@/lib/auth/guard";
import { isDurableUserId } from "@/lib/auth/session";
import {
  clientIp,
  createRateLimiter,
  rateLimitIdentity,
} from "@/lib/rate-limit";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { YOUTUBE_COPY } from "@/lib/youtube/messages";
import { searchYoutube, YoutubeSearchError } from "@/lib/youtube/search";

export const runtime = "nodejs";
export const maxDuration = 20;

/** search.list costs 100 quota units. 8 per 10 minutes stays under a shared daily cap. */
const searchRateLimit = createRateLimiter(8, 10 * 60_000, { onError: "closed" });

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession(request);
    // The edge proxy mints anon_* for every visitor, including a cookieless
    // curl. search.list costs 100 quota units, so only a signed-in user_* may
    // spend them. A pasted link never needs this route.
    if (!isDurableUserId(session.userId)) {
      throw new AppError("SIGN_IN_REQUIRED", YOUTUBE_COPY.signInToSearch, 401);
    }

    const q = new URL(request.url).searchParams.get("q")?.trim() || "";
    if (!q) {
      throw new AppError("INVALID_QUERY", "Type a search or paste a YouTube link.", 400);
    }

    await ensureTtsJobColumns();

    const identity = await rateLimitIdentity({
      userId: session.userId,
      ip: clientIp(request),
    });
    if (!(await searchRateLimit(identity))) {
      return NextResponse.json(
        { error: "Too many searches. Wait a minute and try again.", code: "RATE_LIMIT" },
        { status: 429 }
      );
    }

    try {
      const results = await searchYoutube(q);
      return NextResponse.json({ results });
    } catch (err) {
      if (err instanceof YoutubeSearchError) {
        console.warn("[youtube-search]", err.message);
        return NextResponse.json(
          {
            error: YOUTUBE_COPY.searchUnavailable,
            code: "YOUTUBE_SEARCH_UNAVAILABLE",
            fallback: "upload",
          },
          { status: 503 }
        );
      }
      throw err;
    }
  } catch (error) {
    return handleApiError(error);
  }
}
