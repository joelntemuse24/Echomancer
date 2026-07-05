/**
 * MOSS-TTS Modal URL resolution.
 *
 * Set MOSS_AB_VARIANT and the matching MODAL_MOSS_*_TTS_URL:
 * - sglang (default production) — SGLang-Omni on Modal A100-80GB
 * - delay — MossTTSDelay-8B transformers loop
 * - local — MOSS Local-Transformer
 * - api — hosted MOSI Studio API (no GPUs)
 */

export type MossAbVariant = "delay" | "local" | "api" | "sglang";

const MOSS_BATCH_SUFFIX = "/generate_batch";

export function resolveMossAbVariant(): MossAbVariant {
  const envVariant = process.env.MOSS_AB_VARIANT;
  if (envVariant === "local") return "local";
  if (envVariant === "api") return "api";
  if (envVariant === "sglang") return "sglang";
  return "delay";
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

export function resolveModalBatchUrl(): string | undefined {
  return resolveMossBatchUrl();
}

export function resolveModalBaseUrl(): string | undefined {
  const batch = resolveModalBatchUrl();
  return batch?.replace(MOSS_BATCH_SUFFIX, "");
}