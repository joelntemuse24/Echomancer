/**
 * Shared TTS / Modal URL resolution — MOSS is the production default.
 */

export type TtsPipelineMode = "moss" | "f5";

const MOSS_BATCH_SUFFIX = "/generate_batch";

export function resolveTtsPipelineMode(): TtsPipelineMode {
  const envMode = process.env.TTS_PIPELINE_MODE;
  if (envMode === "moss" || envMode === "f5") return envMode;
  if (process.env.MODAL_MOSS_TTS_URL) return "moss";
  if (process.env.MODAL_TTS_URL?.includes("echomancer-moss-tts")) return "moss";
  return "moss";
}

export function resolveModalBatchUrl(mode?: TtsPipelineMode): string | undefined {
  const pipelineMode = mode ?? resolveTtsPipelineMode();
  if (pipelineMode === "moss") {
    return process.env.MODAL_MOSS_TTS_URL ?? process.env.MODAL_TTS_URL;
  }
  return process.env.MODAL_TTS_URL;
}

export function resolveModalBaseUrl(mode?: TtsPipelineMode): string | undefined {
  const batch = resolveModalBatchUrl(mode);
  return batch?.replace(MOSS_BATCH_SUFFIX, "");
}