/**
 * Bake a clone preview off the request path.
 *
 * The line is the shared `PREVIEW_TEXT`, spoken by this clone's own Fish
 * reference (`cloneProviderPin: "fish"`). Books may still use the S2 pool.
 * The preview never does: a cold pool must not block it, and the bytes are
 * stored under the `fish` v2 key, never under `s2-pro` and never as Drama 3.
 *
 * One user action (create, or Play when nothing is stored, or Retry) enqueues
 * one bake. Further reads do not. A failure is terminal until Retry, and
 * Retry waits out `CLONE_PREVIEW_BACKOFF_MS`.
 *
 * Cost: the clone's model is `s2.1-pro-free` ($0 / million characters in the
 * catalog). At the paid Fish S2.1 Pro rate of $15 / million, the one-liner is
 * still under a tenth of a cent. Waking the H100 for the same line is a cold
 * restore (about 68 s at $3.95 / hour, about $0.07) before any audio.
 */

import { NextResponse } from "next/server";
import { getCatalogVoice } from "@/lib/tts/catalog";
import {
  clonePreviewWritePath,
  findStoredClonePreview,
  planClonePreview,
  previewAudioResponse,
} from "@/lib/tts/clone-preview";
import { storeClonePreview, type ClonePreviewEngine } from "@/lib/tts/clone-preview-store";
import { PREVIEW_TEXT } from "@/lib/tts/preview-text";
import { catalogIdForClone, cloneRowIdFromCatalogId, isFishCloneCatalogId } from "@/lib/tts/fish-clone";
import { fishTtsProvider } from "@/lib/tts/providers/fish";
import { ProviderSlotBusyError } from "@/lib/tts/provider-slots";
import { requestClonePreviewBake, takehomeWorkerUrl } from "@/lib/jobs/takehome-worker-client";
import { ensureTtsJobColumns } from "@/lib/tts/schema-migrate";
import { execute, queryOne } from "@/lib/turso";

/** The only engine a preview bake may render with, and the key it may write. */
export const CLONE_PREVIEW_BAKE_ENGINE: ClonePreviewEngine = "fish";

/** Paid Fish S2.1 Pro list rate, USD per million characters. The free model is $0. */
export const FISH_PAID_USD_PER_MILLION_CHARS = 15;

/**
 * After a failed bake, Retry is refused until this delay for that attempt.
 * The third failure uses the last delay again. Play does not start the next one.
 */
export const CLONE_PREVIEW_BACKOFF_MS = [4_000, 12_000, 30_000] as const;

export const CLONE_PREVIEW_MAX_ATTEMPTS = CLONE_PREVIEW_BACKOFF_MS.length;

/** How long a dispatched bake keeps Play from enqueueing another. */
const RUNNING_HOLD_MS = 45_000;

const PREVIEW_RENDER_BUDGET_MS = 25_000;

type Ledger = {
  attempts: number;
  notBefore: number;
  terminal: boolean;
  runningUntil: number;
};

export type PreviewBakeClaim =
  | { kind: "start" }
  | { kind: "preparing" }
  | { kind: "failed"; retryAfterMs: number };

type BakePayload = {
  status: number;
  audio?: Buffer;
  /** Set when the bytes were already in storage. */
  replayed?: boolean;
  json?: Record<string, unknown>;
};

const inflight = new Map<string, Promise<BakePayload>>();

let nowMs = (): number => Date.now();

export function setClonePreviewNowForTests(fn: (() => number) | null): void {
  nowMs = fn ?? (() => Date.now());
}

export function resetClonePreviewBakeForTests(): void {
  inflight.clear();
  nowMs = () => Date.now();
}

function rowIdOf(catalogVoiceId: string): string | null {
  const id = isFishCloneCatalogId(catalogVoiceId) ? catalogVoiceId : `clone:${catalogVoiceId}`;
  return cloneRowIdFromCatalogId(id);
}

function catalogIdOf(rawId: string): string {
  return isFishCloneCatalogId(rawId) ? rawId : catalogIdForClone(rawId);
}

function backoffMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), CLONE_PREVIEW_BACKOFF_MS.length) - 1;
  return CLONE_PREVIEW_BACKOFF_MS[index]!;
}

async function readLedger(rowId: string): Promise<Ledger | null> {
  const row = await queryOne<{
    preview_bake_attempts: number | null;
    preview_bake_not_before: number | null;
    preview_bake_terminal: number | null;
    preview_bake_running_until: number | null;
  }>(
    `SELECT preview_bake_attempts, preview_bake_not_before, preview_bake_terminal,
            preview_bake_running_until
     FROM cloned_voices WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    [rowId]
  );
  if (!row) return null;
  return {
    attempts: Number(row.preview_bake_attempts) || 0,
    notBefore: Number(row.preview_bake_not_before) || 0,
    terminal: Number(row.preview_bake_terminal) === 1,
    runningUntil: Number(row.preview_bake_running_until) || 0,
  };
}

function claimFromLedger(ledger: Ledger, now: number): PreviewBakeClaim {
  if (ledger.runningUntil > now) return { kind: "preparing" };
  if (ledger.terminal || ledger.notBefore > now) {
    return { kind: "failed", retryAfterMs: Math.max(0, ledger.notBefore - now) };
  }
  return { kind: "start" };
}

/**
 * Reserve one bake. Play and create call this with `force` false: a terminal
 * failure or a live bake does not start another Fish call. Retry passes
 * `force` and still waits out the backoff.
 */
export async function claimClonePreviewBake(
  rawId: string,
  opts?: { force?: boolean; now?: number }
): Promise<PreviewBakeClaim> {
  const rowId = rowIdOf(catalogIdOf(rawId));
  if (!rowId) return { kind: "failed", retryAfterMs: 0 };
  await ensureTtsJobColumns();
  const now = opts?.now ?? nowMs();
  const force = opts?.force === true;
  const runningUntil = now + RUNNING_HOLD_MS;
  const result = await execute(
    `UPDATE cloned_voices
     SET preview_bake_running_until = ?,
         preview_bake_terminal = CASE WHEN ? = 1 THEN 0 ELSE preview_bake_terminal END
     WHERE id = ?
       AND deleted_at IS NULL
       AND (preview_bake_running_until IS NULL OR preview_bake_running_until <= ?)
       AND (preview_bake_not_before IS NULL OR preview_bake_not_before <= ?)
       AND (? = 1 OR COALESCE(preview_bake_terminal, 0) = 0)`,
    [runningUntil, force ? 1 : 0, rowId, now, now, force ? 1 : 0]
  );
  if (result.rowsAffected > 0) return { kind: "start" };
  const ledger = await readLedger(rowId);
  if (!ledger) return { kind: "failed", retryAfterMs: 0 };
  return claimFromLedger(ledger, now);
}

async function clearRunning(rowId: string): Promise<void> {
  await execute(
    `UPDATE cloned_voices SET preview_bake_running_until = NULL WHERE id = ?`,
    [rowId]
  ).catch(() => {});
}

async function releaseClonePreviewBake(rowId: string): Promise<void> {
  await execute(
    `UPDATE cloned_voices
     SET preview_bake_running_until = NULL
     WHERE id = ? AND COALESCE(preview_bake_terminal, 0) = 0`,
    [rowId]
  ).catch(() => {});
}

async function noteBakeSuccess(rowId: string): Promise<void> {
  await execute(
    `UPDATE cloned_voices
     SET preview_bake_attempts = 0,
         preview_bake_not_before = NULL,
         preview_bake_terminal = 0,
         preview_bake_running_until = NULL
     WHERE id = ?`,
    [rowId]
  ).catch(() => {});
}

async function noteBakeFailure(rowId: string, now: number): Promise<void> {
  const ledger = await readLedger(rowId);
  const attempts = Math.min(CLONE_PREVIEW_MAX_ATTEMPTS, (ledger?.attempts ?? 0) + 1);
  await execute(
    `UPDATE cloned_voices
     SET preview_bake_attempts = ?,
         preview_bake_not_before = ?,
         preview_bake_terminal = 1,
         preview_bake_running_until = NULL
     WHERE id = ?`,
    [attempts, now + backoffMs(attempts), rowId]
  ).catch(() => {});
}

function payloadResponse(payload: BakePayload): Response {
  if (payload.audio) {
    return previewAudioResponse(payload.audio, payload.replayed ? "stored" : "generated");
  }
  return NextResponse.json(payload.json ?? { error: "Preparing preview" }, { status: payload.status });
}

function failedPayload(retryAfterMs: number): BakePayload {
  return {
    status: 409,
    json: {
      error: "Couldn't prepare the preview.",
      code: "PREVIEW_BAKE_FAILED",
      retryAfterMs,
      engine: CLONE_PREVIEW_BAKE_ENGINE,
    },
  };
}

/**
 * The worker POST for a bake that `claimClonePreviewBake` already reserved.
 * No worker URL means this process is the worker (or local dev) and renders
 * here. Tests never render from this function, so creating a clone does not
 * call Fish.
 */
export async function dispatchClaimedClonePreviewBake(
  rawId: string,
  opts?: { force?: boolean }
): Promise<void> {
  const catalogVoiceId = catalogIdOf(rawId);
  const rowId = rowIdOf(catalogVoiceId);
  try {
    if (takehomeWorkerUrl()) {
      const ok = await requestClonePreviewBake(catalogVoiceId, { force: opts?.force === true });
      if (!ok && rowId) await releaseClonePreviewBake(rowId);
      return;
    }
    if (process.env.VITEST) {
      if (rowId) await releaseClonePreviewBake(rowId);
      return;
    }
    await bakeClonePreview(catalogVoiceId, opts);
  } catch (err) {
    if (rowId) await releaseClonePreviewBake(rowId);
    console.warn(
      "[clone-preview] enqueue failed:",
      err instanceof Error ? err.message : err
    );
  }
}

/** Reserve one bake and hand it to the worker. Create calls this. */
export async function enqueueClonePreviewBake(
  rawId: string,
  opts?: { force?: boolean }
): Promise<void> {
  const claim = await claimClonePreviewBake(catalogIdOf(rawId), opts);
  if (claim.kind !== "start") return;
  await dispatchClaimedClonePreviewBake(rawId, opts);
}

async function renderFishPreview(input: {
  script: string;
  voiceId: string;
  catalogVoiceId: string;
  language?: string | null;
  model?: string | null;
  speed?: number;
}): Promise<{ audio: Buffer }> {
  const result = await fishTtsProvider.synthesize({
    text: input.script,
    voiceId: input.voiceId,
    catalogVoiceId: input.catalogVoiceId,
    language: input.language ?? undefined,
    model: input.model ?? undefined,
    speed: input.speed,
    allowFallback: false,
    cloneProviderPin: "fish",
    signal: AbortSignal.timeout(PREVIEW_RENDER_BUDGET_MS),
  });
  return { audio: result.audio };
}

async function runBake(rawId: string, opts?: { force?: boolean }): Promise<BakePayload> {
  const catalogVoiceId = catalogIdOf(rawId);
  const rowId = rowIdOf(catalogVoiceId);
  const now = nowMs();
  if (!rowId) {
    return { status: 404, json: { error: "That voice isn't available.", code: "NOT_FOUND" } };
  }
  const owner = await queryOne<{ user_id: string | null }>(
    `SELECT user_id FROM cloned_voices WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    [rowId]
  );
  const catalog = await getCatalogVoice(catalogVoiceId, {
    hdEnabled: true,
    userId: owner?.user_id || undefined,
  });
  if (!catalog) {
    await releaseClonePreviewBake(rowId);
    return { status: 404, json: { error: "That voice isn't available.", code: "NOT_FOUND" } };
  }
  const plan = planClonePreview({ catalogVoiceId: catalog.id, text: PREVIEW_TEXT });
  const writePath = clonePreviewWritePath(
    catalog,
    plan,
    PREVIEW_TEXT,
    CLONE_PREVIEW_BAKE_ENGINE
  );
  if (!writePath || !catalog.providerVoiceId?.trim()) {
    await noteBakeFailure(rowId, now);
    return failedPayload(backoffMs(1));
  }
  const existing = await findStoredClonePreview(
    catalog,
    plan,
    PREVIEW_TEXT,
    CLONE_PREVIEW_BAKE_ENGINE
  );
  if (existing) {
    await noteBakeSuccess(rowId);
    return { status: 200, audio: existing.audio, replayed: true };
  }

  const ledger = await readLedger(rowId);
  if (ledger && ledger.notBefore > now) {
    await clearRunning(rowId);
    return failedPayload(ledger.notBefore - now);
  }
  if (ledger?.terminal && opts?.force !== true) {
    await clearRunning(rowId);
    return failedPayload(0);
  }

  try {
    const result = await renderFishPreview({
      script: plan.script,
      voiceId: catalog.providerVoiceId,
      catalogVoiceId: catalog.id,
      language: catalog.locale,
      model: catalog.model,
      speed: plan.speed,
    });
    const stored = await storeClonePreview(writePath, result.audio);
    if (!stored) {
      await noteBakeFailure(rowId, nowMs());
      return failedPayload(backoffMs((ledger?.attempts ?? 0) + 1));
    }
    await noteBakeSuccess(rowId);
    return { status: 200, audio: result.audio };
  } catch (err) {
    await noteBakeFailure(rowId, nowMs());
    const busy = err instanceof ProviderSlotBusyError;
    console.error(
      `[clone-preview] bake failed for ${catalog.id} on ${CLONE_PREVIEW_BAKE_ENGINE}:`,
      err instanceof Error ? err.message : err
    );
    if (busy) {
      return {
        status: 503,
        json: {
          error: "That voice is busy right now. Nothing else was substituted.",
          code: "PREVIEW_CAPACITY",
          engine: CLONE_PREVIEW_BAKE_ENGINE,
        },
      };
    }
    const after = await readLedger(rowId);
    return failedPayload(Math.max(0, (after?.notBefore ?? 0) - nowMs()));
  }
}

/**
 * Render the preview line with Fish and store it under the fish key.
 * A second call for the same clone joins the first. A cold S2 pool is ignored.
 */
export async function bakeClonePreview(
  rawId: string,
  opts?: { force?: boolean }
): Promise<Response> {
  const key = catalogIdOf(rawId);
  const existing = inflight.get(key);
  if (existing) return existing.then(payloadResponse);
  const rowId = rowIdOf(key);
  const slot: { run?: Promise<BakePayload> } = {};
  const run = runBake(rawId, opts)
    .catch(async (err) => {
      console.error(
        `[clone-preview] bake failed for ${key} on ${CLONE_PREVIEW_BAKE_ENGINE}:`,
        err instanceof Error ? err.message : err
      );
      if (rowId) await noteBakeFailure(rowId, nowMs());
      return failedPayload(backoffMs(1));
    })
    .finally(() => {
      if (slot.run && inflight.get(key) === slot.run) inflight.delete(key);
    });
  slot.run = run;
  inflight.set(key, run);
  return run.then(payloadResponse);
}
