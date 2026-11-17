/**
 * `/api/tts/clones/[id]/preview` — a saved clone's sample clip.
 *
 * ## GET: replay the saved MP3, nothing else
 *
 * This never synthesizes. Selecting a voice the person already made must play
 * the object that is already in storage, because the alternative — rendering
 * the line again — can mean waiting on a scale-to-zero GPU pool. It is tried in
 * this order:
 *
 *   1. the take this clone's current engine rendered,
 *   2. the legacy engine-free preview key, which holds the Fish 2.1 Pro MP3s
 *      written before the S2 pool existed.
 *
 * Both are this clone's voice. When nothing is stored the route answers
 * `202 PREVIEW_PREPARING` and asks the worker to bake the clip. It does not
 * synthesize, and it does not call `/api/tts/live`.
 *
 * ## POST: enqueue the same bake
 *
 * A stored take is replayed. A missing take is the worker's job. The request
 * path never renders a clone preview.
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
  clonePreviewEngine,
  clonePreviewReadPaths,
  clonePreviewWritePath,
  findStoredClonePreview,
  planClonePreview,
  previewAudioResponse,
} from "@/lib/tts/clone-preview";
import { enqueueClonePreviewBake } from "@/lib/tts/clone-preview-job";

export const runtime = "nodejs";
/**
 * A cold S2 restore plus one line has to fit inside this. The render path does
 * not attempt a cold restore at all any more — it reports `PREVIEW_ENGINE_COLD`
 * and warms the pool instead — so this covers a warm container plus the
 * `PREVIEW_RENDER_BUDGET_MS` wait, with room for the storage write.
 */
export const maxDuration = 60;

// A cache probe is far cheaper than a synthesis call, so this limit is only
// abuse cover. The render below has its own, much tighter, meter.
const previewCacheRateLimit = createRateLimiter("clone-preview-cache", 120, 60_000, {
  onError: "open",
});
// One explicit render per clone per minute is plenty: a preview is a fixed
// line, so re-rendering it is either a retry after a visible failure or a
// deliberate refresh, never something a page does on its own.
const previewRenderRateLimit = createRateLimiter("clone-preview-render", 6, 60_000, {
  onError: "closed",
});

/** The caller's own clone, or null (which the route reports as 404). */
async function ownedClone(request: NextRequest, raw: string) {
  const session = await requireSession(request);
  const catalogVoiceId = isFishCloneCatalogId(raw) ? raw : `clone:${raw}`;
  const catalog = await getCatalogVoice(catalogVoiceId, {
    hdEnabled: true,
    userId: session.userId,
  });
  return catalog ? { session, catalog } : null;
}

function storagePathOr404(): NextResponse {
  return NextResponse.json(
    { error: "That sample isn't available.", code: "NOT_FOUND" },
    { status: 404 }
  );
}

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
    // User-scoped: another session's clone resolves to nothing at all.
    const owned = await ownedClone(request, raw);
    if (!owned) {
      return NextResponse.json(
        { error: "That voice isn't available.", code: "NOT_FOUND" },
        { status: 404 }
      );
    }
    const { catalog } = owned;
    const paths = clonePreviewReadPaths(
      catalog,
      planClonePreview({ catalogVoiceId: catalog.id, text: PREVIEW_TEXT })
    );
    if (paths.length === 0) return storagePathOr404();

    // Read-only. `/api/tts/live` is never reached from here, so a saved voice
    // cannot start a synthesis just because someone pressed play.
    const stored = await findStoredClonePreview(
      catalog,
      planClonePreview({ catalogVoiceId: catalog.id, text: PREVIEW_TEXT })
    );
    if (stored) return previewAudioResponse(stored.audio, "stored");

    // Nothing stored yet. The worker bakes the clip. This request does not
    // synthesize, and it does not fall through to `/api/tts/live`.
    await enqueueClonePreviewBake(catalog.id);
    return NextResponse.json(
      { error: "Preparing preview", code: "PREVIEW_PREPARING" },
      { status: 202 }
    );
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Render the preview once, on the clone's own engine, and store it.
 *
 * The caller is the voice screen, after GET said `PREVIEW_NOT_STORED` or after
 * the person explicitly asked for a fresh sample. `allowFallback: false` is the
 * point of this route: a Modal fault surfaces here instead of being answered by
 * a hosted model that only approximates the voice.
 */
export async function POST(
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
      !(await previewRenderRateLimit(
        await rateLimitIdentity({ userId: session.userId, ip: clientIp(request) })
      ))
    ) {
      return NextResponse.json(
        { error: "Too fast. Wait a minute." },
        { status: 429 }
      );
    }

    const { id: raw } = await ctx.params;
    const owned = await ownedClone(request, raw);
    if (!owned) {
      return NextResponse.json(
        { error: "That voice isn't available.", code: "NOT_FOUND" },
        { status: 404 }
      );
    }
    const { catalog } = owned;
    const plan = planClonePreview({
      catalogVoiceId: catalog.id,
      text: PREVIEW_TEXT,
    });
    const engine = clonePreviewEngine(catalog.id);
    const writePath = clonePreviewWritePath(catalog, plan, PREVIEW_TEXT, engine);
    if (!writePath) {
      return NextResponse.json(
        { error: "That sample isn't available.", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    // A render that lands twice must not bill twice: if the take is already
    // there (including the legacy Fish 2.1 file), answer with it.
    const existing = await findStoredClonePreview(catalog, plan, PREVIEW_TEXT, engine);
    if (existing) return previewAudioResponse(existing.audio, "stored");

    // The 60s request path does not render. The worker bakes the clip.
    await enqueueClonePreviewBake(catalog.id);
    return NextResponse.json(
      { error: "Preparing preview", code: "PREVIEW_PREPARING", engine },
      { status: 202 }
    );
  } catch (error) {
    return handleApiError(error);
  }
}
