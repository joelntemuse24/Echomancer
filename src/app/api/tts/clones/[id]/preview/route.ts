/**
 * `/api/tts/clones/[id]/preview` — a saved clone's sample clip.
 *
 * ## GET: replay the saved MP3, nothing else
 *
 * This never synthesizes. Selecting a voice the person already made must play
 * the object that is already in storage, because the alternative — rendering
 * the line again — can mean waiting on a scale-to-zero GPU pool. A remembered
 * `preview_storage_path` is streamed only when it is one of this clone's
 * candidate keys. A 16-hex `v` token names one of those keys. A silent or
 * non-audio opening is refused. A token that misses still tries the
 * remembered key. The walk below runs when those objects are missing:
 *
 *   1. the fish v2 key, which is where a new bake is stored,
 *   2. the legacy engine-free preview key, which holds the Fish 2.1 Pro MP3s
 *      written before the S2 pool existed,
 *   3. an older s2-pro v2 key.
 *
 * Both are this clone's voice. When nothing is stored, Play asks the worker
 * for one Fish bake of `PREVIEW_TEXT` (the clone's own reference, never the
 * S2 pool). A bake already running answers `202 PREVIEW_PREPARING` and does
 * not start another. A failed bake answers `409 PREVIEW_BAKE_FAILED` until
 * Retry. This route does not synthesize.
 *
 * ## POST: the Retry button
 *
 * `{ retry: true }` asks for one more Fish bake after the backoff. A stored
 * take is still replayed, so Retry does not render a second time once the
 * clip exists.
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
import { isFishCloneCatalogId, cloneRowIdFromCatalogId, clonedVoiceToCatalog } from "@/lib/tts/fish-clone";
import { getClonedVoiceForUser } from "@/lib/turso/cloned-voices";
import { PREVIEW_TEXT } from "@/lib/tts/preview-text";
import {
  clonePreviewReadPaths,
  clonePreviewStatusHeaders,
  planClonePreview,
  respondStoredClonePreview,
} from "@/lib/tts/clone-preview";
import {
  claimClonePreviewBake,
  CLONE_PREVIEW_BAKE_ENGINE,
  dispatchClaimedClonePreviewBake,
  readClonePreviewBakeStatus,
} from "@/lib/tts/clone-preview-job";

export const runtime = "nodejs";
/** One person's clip. Never a static or shared cache entry. */
export const dynamic = "force-dynamic";
/** The request only reads storage or enqueues. The worker renders the line. */
export const maxDuration = 60;

const PRIVATE_JSON = clonePreviewStatusHeaders();

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
async function ownedClone(userId: string, raw: string) {
  const catalogVoiceId = isFishCloneCatalogId(raw) ? raw : `clone:${raw}`;
  const rowId = cloneRowIdFromCatalogId(catalogVoiceId);
  if (!rowId) return null;
  const row = await getClonedVoiceForUser(userId, rowId);
  if (!row) return null;
  return { catalog: clonedVoiceToCatalog(row), row };
}

function storagePathOr404(): NextResponse {
  return NextResponse.json(
    { error: "That sample isn't available.", code: "NOT_FOUND" },
    { status: 404, headers: PRIVATE_JSON }
  );
}

function bakeFailed(retryAfterMs: number): NextResponse {
  return NextResponse.json(
    {
      error: "Couldn't prepare the preview.",
      code: "PREVIEW_BAKE_FAILED",
      retryAfterMs,
      engine: CLONE_PREVIEW_BAKE_ENGINE,
    },
    { status: 409, headers: PRIVATE_JSON }
  );
}

function bakePreparing(): NextResponse {
  return NextResponse.json(
    {
      error: "Preparing preview",
      code: "PREVIEW_PREPARING",
      engine: CLONE_PREVIEW_BAKE_ENGINE,
    },
    { status: 202, headers: PRIVATE_JSON }
  );
}

/** Polls only read the ledger. They do not reserve or start a Fish bake. */
async function answerBakeStatus(catalogVoiceId: string): Promise<NextResponse> {
  const claim = await readClonePreviewBakeStatus(catalogVoiceId);
  if (claim.kind === "preparing") return bakePreparing();
  return bakeFailed(claim.kind === "failed" ? claim.retryAfterMs : 0);
}

/** One Fish bake, or the ledger's answer when one is already running or failed. */
async function answerUnstoredPreview(
  catalogVoiceId: string,
  force: boolean
): Promise<NextResponse> {
  const claim = await claimClonePreviewBake(catalogVoiceId, { force });
  if (claim.kind === "failed") return bakeFailed(claim.retryAfterMs);
  if (claim.kind === "start") {
    const sent = await dispatchClaimedClonePreviewBake(catalogVoiceId, {
      force,
      ifUnsent: "fail",
    });
    if (!sent.ok) return bakeFailed(sent.retryAfterMs);
  }
  return bakePreparing();
}

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    if (!isFishConfigured()) {
      return NextResponse.json(
        { error: "Cloning isn't available right now.", code: "FISH_NOT_CONFIGURED" },
        { status: 503, headers: PRIVATE_JSON }
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
        { status: 429, headers: PRIVATE_JSON }
      );
    }

    const { id: raw } = await ctx.params;
    // User-scoped: another session's clone resolves to nothing at all.
    const owned = await ownedClone(session.userId, raw);
    if (!owned) {
      return NextResponse.json(
        { error: "That voice isn't available.", code: "NOT_FOUND" },
        { status: 404, headers: PRIVATE_JSON }
      );
    }
    const { catalog, row } = owned;
    const plan = planClonePreview({ catalogVoiceId: catalog.id, text: PREVIEW_TEXT });
    const paths = clonePreviewReadPaths(catalog, plan);
    if (paths.length === 0) return storagePathOr404();

    // Read-only. A remembered key or a `v` token is streamed. The key walk
    // runs only when that object is missing. `/api/tts/live` is never reached
    // from here, so a saved voice cannot start a synthesis on play.
    const stored = await respondStoredClonePreview({
      request,
      voice: catalog,
      plan,
      savedPath: row.preview_storage_path,
      versionToken: new URL(request.url).searchParams.get("v"),
    });
    if (stored) return stored;

    // Nothing stored yet. The first Play enqueues one Fish bake. A poll
    // (`poll=1`) only reads the ledger, so it cannot start another.
    const poll = new URL(request.url).searchParams.get("poll") === "1";
    if (poll) return answerBakeStatus(catalog.id);
    return answerUnstoredPreview(catalog.id, false);
  } catch (error) {
    return handleApiError(error);
  }
}

/** Retry one Fish bake after a failed Play. A stored take is replayed as-is. */
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    if (!isFishConfigured()) {
      return NextResponse.json(
        { error: "Cloning isn't available right now.", code: "FISH_NOT_CONFIGURED" },
        { status: 503, headers: PRIVATE_JSON }
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
        { status: 429, headers: PRIVATE_JSON }
      );
    }

    const { id: raw } = await ctx.params;
    const owned = await ownedClone(session.userId, raw);
    if (!owned) {
      return NextResponse.json(
        { error: "That voice isn't available.", code: "NOT_FOUND" },
        { status: 404, headers: PRIVATE_JSON }
      );
    }
    const { catalog, row } = owned;
    const plan = planClonePreview({
      catalogVoiceId: catalog.id,
      text: PREVIEW_TEXT,
    });
    const paths = clonePreviewReadPaths(catalog, plan);
    if (paths.length === 0) return storagePathOr404();

    // A clip that already exists is the preview. Retry does not render it again.
    const existing = await respondStoredClonePreview({
      request,
      voice: catalog,
      plan,
      savedPath: row.preview_storage_path,
      versionToken: null,
    });
    if (existing) return existing;

    let force = false;
    try {
      const body = (await request.json()) as { retry?: unknown };
      force = body?.retry === true;
    } catch {
      force = false;
    }
    return answerUnstoredPreview(catalog.id, force);
  } catch (error) {
    return handleApiError(error);
  }
}
