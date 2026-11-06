/**
 * GET /api/tts/clones/[id]/preview — a saved clone's stored sample clip.
 *
 * The picker asks for this *before* `/api/tts/live`. When a take is stored the
 * answer is that audio, so selecting a voice the person already has never
 * calls Fish, never waits on a cold GPU pool, and plays as fast as a committed
 * stock recording.
 *
 * This exists as its own route so the "is there a saved clip?" question cannot
 * accidentally spend a synthesis call: `/api/tts/live` renders and stores the
 * one-liner when nothing is there, which is correct for the very first play
 * and wrong for every play after it.
 *
 * `404` therefore means exactly one thing — nothing is stored for this clone
 * yet — and the caller then asks `/api/tts/live` to render it once. Another
 * session's clone is also `404` (ids are never enumerable), which is
 * indistinguishable from "not stored" by design: the follow-up request is
 * scoped to the caller too, so a non-owner gains nothing either way.
 */

import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/errors";
import { requireSession } from "@/lib/auth/guard";
import {
  clientIp,
  createRateLimiter,
  rateLimitIdentity,
} from "@/lib/rate-limit";
import { isFishConfigured } from "@/lib/tts/providers/fish";
import { getCatalogVoice } from "@/lib/tts/catalog";
import { isFishCloneCatalogId } from "@/lib/tts/fish-clone";
import { PREVIEW_TEXT } from "@/lib/tts/preview-text";
import {
  clonePreviewPathForCatalog,
  planClonePreview,
  previewAudioResponse,
  storedClonePreviewAudio,
} from "@/lib/tts/clone-preview";

export const runtime = "nodejs";
export const maxDuration = 30;

// Same order of magnitude as the other preview paths. A cache probe is much
// cheaper than a synthesis call, so this limit is only abuse cover.
const previewCacheRateLimit = createRateLimiter("clone-preview-cache", 120, 60_000, {
  onError: "open",
});

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    if (!isFishConfigured()) {
      return NextResponse.json(
        { error: "Cloning isn't available right now.", code: "FISH_NOT_CONFIGURED" },
        { status: 503 }
      );
    }

    const session = await requireSession(request);
    if (
      !(await previewCacheRateLimit(
        await rateLimitIdentity({ userId: session.userId, ip: clientIp(request) })
      ))
    ) {
      return NextResponse.json(
        { error: "Too fast. Wait a minute." },
        { status: 429 }
      );
    }

    const { id: raw } = await ctx.params;
    const catalogVoiceId = isFishCloneCatalogId(raw) ? raw : `clone:${raw}`;

    // User-scoped: another session's clone resolves to nothing at all.
    const catalog = await getCatalogVoice(catalogVoiceId, {
      hdEnabled: true,
      userId: session.userId,
    });
    if (!catalog) {
      return NextResponse.json(
        { error: "That voice isn't available.", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    // Same one-liner and speed `/api/tts/live` renders, so the key matches.
    const plan = planClonePreview({
      catalogVoiceId: catalog.id,
      text: PREVIEW_TEXT,
    });
    const storagePath = clonePreviewPathForCatalog(catalog, plan, PREVIEW_TEXT);
    if (!storagePath) {
      return NextResponse.json(
        { error: "That sample isn't available.", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    const stored = await storedClonePreviewAudio(storagePath);
    if (stored) return previewAudioResponse(stored, "stored");

    // Nothing stored yet. Distinct code so the caller knows a render is next
    // rather than a failure, and there is nothing to retry.
    return NextResponse.json(
      { error: "No saved sample yet.", code: "PREVIEW_NOT_STORED" },
      { status: 404 }
    );
  } catch (error) {
    return handleApiError(error);
  }
}
