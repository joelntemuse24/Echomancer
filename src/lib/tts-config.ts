/**
 * Shared TTS / Modal URL resolution — MOSS is the production default.
 *
 * A/B: set MOSS_AB_VARIANT=local|delay and point MODAL_MOSS_LOCAL_TTS_URL /
 * MODAL_MOSS_TTS_URL at the respective Modal apps.
 */

export type TtsPipelineMode = "moss" | "f5";
export type MossAbVariant = "delay" | "local";

const MOSS_BATCH_SUFFIX = "/generate_batch";

export function resolveMossAbVariant(): MossAbVariant {
  const envVariant = process.env.MOSS_AB_VARIANT;
  if (envVariant === "local") return "local";
  return "delay";
}

export function resolveTtsPipelineMode(): TtsPipelineMode {
  const envMode = process.env.TTS_PIPELINE_MODE;
  if (envMode === "moss" || envMode === "f5") return envMode;
  if (process.env.MODAL_MOSS_TTS_URL || process.env.MODAL_MOSS_LOCAL_TTS_URL) {
    return "moss";
  }
  if (process.env.MODAL_TTS_URL?.includes("echomancer-moss")) return "moss";
  return "moss";
}

function resolveMossBatchUrl(variant?: MossAbVariant): string | undefined {
  const mossVariant = variant ?? resolveMossAbVariant();
  if (mossVariant === "local") {
    return (
      process.env.MODAL_MOSS_LOCAL_TTS_URL ??
      process.env.MODAL_TTS_URL
    );
  }
  return (
    process.env.MODAL_MOSS_DELAY_TTS_URL ??
    process.env.MODAL_MOSS_TTS_URL ??
    process.env.MODAL_TTS_URL
  );
}

export function resolveModalBatchUrl(mode?: TtsPipelineMode): string | undefined {
  const pipelineMode = mode ?? resolveTtsPipelineMode();
  if (pipelineMode === "moss") {
    return resolveMossBatchUrl();
  }
  return process.env.MODAL_TTS_URL;
}

export function resolveModalBaseUrl(mode?: TtsPipelineMode): string | undefined {
  const batch = resolveModalBatchUrl(mode);
  return batch?.replace(MOSS_BATCH_SUFFIX, "");
}