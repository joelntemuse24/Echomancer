/**
 * Bake a clone preview off the request path.
 *
 * The voice screen only reads storage. This function is what the worker
 * runs, once, with `allowFallback: false`. A cold pool is reported and
 * nothing is stored. A second bake of a stored take does not synthesize.
 */

import { NextResponse } from "next/server";
import { getCatalogVoice } from "@/lib/tts/catalog";
import {
  clonePreviewEngine,
  clonePreviewWritePath,
  findStoredClonePreview,
  planClonePreview,
  previewAudioResponse,
} from "@/lib/tts/clone-preview";
import { storeClonePreview } from "@/lib/tts/clone-preview-store";
import { PREVIEW_TEXT } from "@/lib/tts/preview-text";
import { isFishCloneCatalogId } from "@/lib/tts/fish-clone";
import { resolveStockAdapter } from "@/lib/tts/providers";
import {
  ModalCloneColdError,
  synthesizeModalClonePreview,
} from "@/lib/tts/providers/modal-clone";
import { ProviderSlotBusyError } from "@/lib/tts/provider-slots";
import { admitRemoteCall } from "@/lib/remote/layer";
import { requestClonePreviewBake } from "@/lib/jobs/takehome-worker-client";
import { queryOne } from "@/lib/turso";

const PREVIEW_RENDER_BUDGET_MS = 35_000;

export async function enqueueClonePreviewBake(catalogVoiceId: string): Promise<void> {
  const admitted = admitRemoteCall({
    provider: "preview",
    path: "preview",
    sections: [catalogVoiceId],
    estCostUsd: 0.05,
    estMs: PREVIEW_RENDER_BUDGET_MS,
  });
  if (admitted.kind !== "start") return;
  try {
    await requestClonePreviewBake(catalogVoiceId);
    admitted.finish("success");
  } catch (err) {
    admitted.finish("failure", err instanceof Error ? err.message : String(err));
  }
}

export async function bakeClonePreview(rawId: string): Promise<Response> {
  const catalogVoiceId = isFishCloneCatalogId(rawId) ? rawId : `clone:${rawId}`;
  const owner = await queryOne<{ user_id: string | null }>(
    `SELECT user_id FROM cloned_voices WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    [catalogVoiceId.slice("clone:".length)]
  );
  const catalog = await getCatalogVoice(catalogVoiceId, {
    hdEnabled: true,
    userId: owner?.user_id || undefined,
  });
  if (!catalog) {
    return NextResponse.json(
      { error: "That voice isn't available.", code: "NOT_FOUND" },
      { status: 404 }
    );
  }
  const plan = planClonePreview({ catalogVoiceId: catalog.id, text: PREVIEW_TEXT });
  const engine = clonePreviewEngine(catalog.id);
  const writePath = clonePreviewWritePath(catalog, plan, PREVIEW_TEXT, engine);
  if (!writePath) {
    return NextResponse.json(
      { error: "That sample isn't available.", code: "NOT_FOUND" },
      { status: 404 }
    );
  }
  const existing = await findStoredClonePreview(catalog, plan, PREVIEW_TEXT, engine);
  if (existing) return previewAudioResponse(existing.audio, "stored");

  const admitted = admitRemoteCall({
    provider: "preview",
    path: "preview",
    sections: [`bake:${catalog.id}`],
    estCostUsd: 0.05,
    estMs: PREVIEW_RENDER_BUDGET_MS,
  });
  if (admitted.kind === "blocked") {
    return NextResponse.json(
      { error: "Preparing preview", code: "PREVIEW_PREPARING" },
      { status: 202 }
    );
  }
  if (admitted.kind === "join") {
    return NextResponse.json(
      { error: "Preparing preview", code: "PREVIEW_PREPARING" },
      { status: 202 }
    );
  }

  try {
    const result =
      engine === "s2-pro"
        ? await synthesizeModalClonePreview({
            text: plan.script,
            voiceId: catalog.providerVoiceId,
            catalogVoiceId: catalog.id,
            language: catalog.locale,
            model: catalog.model,
            speed: plan.speed,
            allowFallback: false,
            budgetMs: PREVIEW_RENDER_BUDGET_MS,
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
            allowFallback: false,
          });
    await storeClonePreview(writePath, result.audio);
    admitted.finish("success");
    return previewAudioResponse(result.audio, "generated");
  } catch (err) {
    admitted.finish("failure", err instanceof Error ? err.message : String(err));
    const cold = err instanceof ModalCloneColdError;
    const busy = err instanceof ProviderSlotBusyError;
    console.error(
      `[clone-preview] bake failed for ${catalog.id} on ${engine}:`,
      err instanceof Error ? err.message : err
    );
    return NextResponse.json(
      {
        error: cold
          ? "Your cloned voice is starting up. Try again in a moment — nothing else was substituted."
          : busy
            ? "That voice is busy right now. Nothing else was substituted."
            : "That voice's sample couldn't be made right now. Nothing else was substituted.",
        code: cold ? "PREVIEW_ENGINE_COLD" : busy ? "PREVIEW_CAPACITY" : "PREVIEW_RENDER_FAILED",
        engine,
      },
      { status: cold || busy ? 503 : 502 }
    );
  }
}
