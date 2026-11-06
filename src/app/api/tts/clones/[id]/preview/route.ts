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
 * Both are this clone's voice. A `404` therefore means "nothing is stored", and
 * says so with `PREVIEW_NOT_STORED`; the picker only then asks for a render.
 *
 * ## POST: render once, on the engine that speaks this clone
 *
 * An explicit render is the one moment a preview is allowed to cost synthesis.
 * It goes through the clone's real engine with `allowFallback: false`, so a
 * Modal failure surfaces instead of being answered by a different voice. The
 * take is stored under an engine-named key; nothing else may write one.
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
import { resolveStockAdapter } from "@/lib/tts/providers";
import {
  clonePreviewEngine,
  clonePreviewReadPaths,
  clonePreviewWritePath,
  findStoredClonePreview,
  planClonePreview,
  previewAudioResponse,
} from "@/lib/tts/clone-preview";
import { storeClonePreview } from "@/lib/tts/clone-preview-store";
import {
  ModalCloneColdError,
  synthesizeModalClonePreview,
} from "@/lib/tts/providers/modal-clone";

export const runtime = "nodejs";
/**
 * A cold S2 restore plus one line has to fit inside this. The render path does
 * not attempt a cold restore at all any more — it reports `PREVIEW_ENGINE_COLD`
 * and warms the pool instead — so this covers a warm container plus the
 * `PREVIEW_RENDER_BUDGET_MS` wait, with room for the storage write.
 */
export const maxDuration = 60;

/**
 * How long one warm container may take to render this one line.
 *
 * Sized so a warm render cannot run past the function: the measured warm figure
 * is ~14 s for a 300-character take plus a few seconds of mastering, so 35 s is
 * several times the real cost and still leaves the route ~20 s of headroom
 * before Vercel's 60 s ceiling. It is deliberately *not*
 * `MODAL_S2_COLD_WAIT_MS` — that is the book budget, and it cannot fit here.
 */
const PREVIEW_RENDER_BUDGET_MS = 35_000;

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

    // Nothing stored yet. Distinct code so the caller knows a render is next
    // rather than a failure, and there is nothing to retry.
    return NextResponse.json(
      { error: "No saved sample yet.", code: "PREVIEW_NOT_STORED", render: true },
      { status: 404 }
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

    // A preview is somebody waiting on a tap inside a function Vercel kills at
    // 60 s. A book may park for a snapshot restore; this may not. On the S2
    // engine the render therefore refuses to open a cold-restore wait, reports
    // `PREVIEW_ENGINE_COLD` immediately, and kicks a restore so the next tap is
    // a storage read. See `synthesizeModalClonePreview`.
    const previewBudgetMs = PREVIEW_RENDER_BUDGET_MS;
    let result;
    try {
      result = engine === "s2-pro"
        ? await synthesizeModalClonePreview({
            text: plan.script,
            voiceId: catalog.providerVoiceId,
            catalogVoiceId: catalog.id,
            language: catalog.locale,
            model: catalog.model,
            speed: plan.speed,
            allowFallback: false,
            budgetMs: previewBudgetMs,
          })
        : await resolveStockAdapter({
            provider: catalog.provider,
            model: catalog.model,
            catalogVoiceId: catalog.id,
          }).synthesize({
            text: plan.script,
            voiceId: catalog.providerVoiceId,
            catalogVoiceId: catalog.id,
            language: catalog.locale,
            model: catalog.model,
            speed: plan.speed,
            // The whole point: no substitution. A failure is reported, never
            // answered by another engine's take.
            allowFallback: false,
          });
    } catch (err) {
      console.error(
        `[clone-preview] render failed for ${catalog.id} on ${engine}:`,
        err instanceof Error ? err.message : err
      );
      // A cold pool is a wait, not a broken voice. Both cases say plainly that
      // nothing was substituted, and neither leaks the provider's own wording.
      const cold = err instanceof ModalCloneColdError;
      return NextResponse.json(
        {
          error: cold
            ? "Your cloned voice is starting up. Try again in a moment — nothing else was substituted."
            : "That voice's sample couldn't be made right now. Nothing else was substituted.",
          code: cold ? "PREVIEW_ENGINE_COLD" : "PREVIEW_RENDER_FAILED",
          engine,
        },
        { status: cold ? 503 : 502 }
      );
    }

    // Store before answering, so the next play is a plain read.
    await storeClonePreview(writePath, result.audio);
    return previewAudioResponse(result.audio, "generated");
  } catch (error) {
    return handleApiError(error);
  }
}
