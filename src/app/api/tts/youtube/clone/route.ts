/**
 * Ask the always-on worker to clip a YouTube range and clone it.
 * This route does not download audio.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError, AppError } from "@/lib/errors";
import { requireSession } from "@/lib/auth/guard";
import {
  clientIp,
  createRateLimiter,
  rateLimitIdentity,
} from "@/lib/rate-limit";
import { isFishConfigured } from "@/lib/tts/providers/fish";
import { CLONE_ACCENTS } from "@/lib/tts/clone-accent";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import {
  rejectMultipartUpload,
  rejectOversizedFunctionBody,
} from "@/lib/uploads/http";
import { YOUTUBE_COPY } from "@/lib/youtube/messages";
import { isYoutubeVideoId, validateClipRange } from "@/lib/youtube/range";
import { requestYoutubeClipOnWorker } from "@/lib/youtube/worker-client";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Same 5/hour window as file-upload clones, so the counters add together. */
const cloneRateLimit = createRateLimiter(5, 60 * 60_000, { onError: "closed" });

const bodySchema = z.object({
  videoId: z.string().trim(),
  startSec: z.number(),
  endSec: z.number(),
  title: z.string().trim().max(80).optional(),
  accent: z.enum(CLONE_ACCENTS).optional(),
  consent: z.literal(true),
});

export async function POST(request: NextRequest) {
  try {
    await ensureTtsJobColumns();
    rejectMultipartUpload(request, "Send JSON, not a file.");
    rejectOversizedFunctionBody(request);

    const session = await requireSession(request);
    if (!isFishConfigured()) {
      throw new AppError(
        "FISH_NOT_CONFIGURED",
        "Voice cloning isn't available right now.",
        503
      );
    }

    const identity = await rateLimitIdentity({
      userId: session.userId,
      ip: clientIp(request),
    });
    if (!(await cloneRateLimit(identity))) {
      return NextResponse.json(
        { error: "Too many clone attempts. Try again later.", code: "RATE_LIMIT" },
        { status: 429 }
      );
    }

    const raw = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      const missingConsent = parsed.error.issues.some((issue) =>
        issue.path.includes("consent")
      );
      throw new AppError(
        "INVALID_BODY",
        missingConsent ? YOUTUBE_COPY.consentRequired : YOUTUBE_COPY.rangeInvalid,
        400
      );
    }
    if (!isYoutubeVideoId(parsed.data.videoId)) {
      throw new AppError("INVALID_BODY", "That link is not a YouTube video.", 400);
    }

    const range = validateClipRange(parsed.data.startSec, parsed.data.endSec);
    if (!range.ok) {
      throw new AppError("INVALID_RANGE", range.message, 400);
    }

    const result = await requestYoutubeClipOnWorker({
      userId: session.userId,
      videoId: parsed.data.videoId,
      startSec: range.startSec,
      endSec: range.endSec,
      title: parsed.data.title,
      accent: parsed.data.accent,
      consent: true,
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          error: result.message,
          code: result.code,
          fallback: "upload",
        },
        { status: result.status }
      );
    }

    return NextResponse.json({
      clone: result.clone,
      strategy: result.strategy,
      timings: result.timings,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
