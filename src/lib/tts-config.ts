/**
 * Shared TTS / Modal URL resolution — MOSS is the production default.
 *
 * A/B: set MOSS_AB_VARIANT=local|delay|api|sglang and point the matching
 * MODAL_MOSS_*_TTS_URL at the respective Modal apps.
 * "api" routes through the hosted MOSI Studio API (same MOSS-TTS model, no GPUs).
 * "sglang" runs MOSS-TTS-v1.5 through SGLang-Omni on Modal GPUs.
 */

export type TtsPipelineMode = "moss" | "f5";
export type MossAbVariant = "delay" | "local" | "api" | "sglang";

const MOSS_BATCH_SUFFIX = "/generate_batch";

export function resolveMossAbVariant(): MossAbVariant {
  const envVariant = process.env.MOSS_AB_VARIANT;
  if (envVariant === "local") return "local";
  if (envVariant === "api") return "api";
  if (envVariant === "sglang") return "sglang";
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
  if (mossVariant === "api") {
    return (
      process.env.MODAL_MOSS_API_TTS_URL ??
      process.env.MODAL_TTS_URL
    );
  }
  if (mossVariant === "sglang") {
    return (
      process.env.MODAL_MOSS_SGLANG_TTS_URL ??
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