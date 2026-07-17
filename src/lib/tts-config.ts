/**
 * MOSS-TTS Modal URL resolution.
 *
 * Production uses the flagship SGLang-Omni worker (MOSS-TTS-v1.5 on A100-80GB).
 * Set MOSS_AB_VARIANT only for intentional rollback:
 * - sglang (default) — SGLang-Omni on Modal A100-80GB
 * - delay — MossTTSDelay-8B transformers loop
 * - local — MOSS Local-Transformer
 * - api — hosted MOSI Studio API (no GPUs)
 *
 * Quantized OpenMOSS / GGUF candidates are not production routes.
 */

export type MossAbVariant = "delay" | "local" | "api" | "sglang" | "openmoss";
export type TtsRoutingContext = "preview" | "audiobook";

export interface TtsJobSize {
  charCount?: number | null;
  paragraphCount?: number | null;
}

export interface TtsRoute {
  variant: MossAbVariant;
  batchUrl: string | undefined;
  isShortJob: boolean;
}

const MOSS_BATCH_SUFFIX = "/generate_batch";
const DEFAULT_SHORT_JOB_CHAR_THRESHOLD = 2500;

function firstConfiguredUrl(
  ...values: Array<string | undefined>
): string | undefined {
  return values.find((value) => Boolean(value?.trim()));
}

export function resolveMossAbVariant(): MossAbVariant {
  const envVariant = process.env.MOSS_AB_VARIANT;
  // Explicit rollback backends only. openmoss / unknown / unset → flagship.
  if (envVariant === "delay") return "delay";
  if (envVariant === "local") return "local";
  if (envVariant === "api") return "api";
  return "sglang";
}

export function resolveMossBatchUrl(
  variant?: MossAbVariant,
  allowGenericFallback = true
): string | undefined {
  const mossVariant = variant ?? resolveMossAbVariant();
  if (mossVariant === "local") {
    return firstConfiguredUrl(
      process.env.MODAL_MOSS_LOCAL_TTS_URL,
      (allowGenericFallback ? process.env.MODAL_TTS_URL : undefined)
    );
  }
  if (mossVariant === "api") {
    return firstConfiguredUrl(
      process.env.MODAL_MOSS_API_TTS_URL,
      (allowGenericFallback ? process.env.MODAL_TTS_URL : undefined)
    );
  }
  if (mossVariant === "sglang") {
    return firstConfiguredUrl(
      process.env.MODAL_MOSS_SGLANG_TTS_URL,
      (allowGenericFallback ? process.env.MODAL_TTS_URL : undefined)
    );
  }
  if (mossVariant === "openmoss") {
    // Retries of legacy OpenMOSS jobs only — not selected for new work.
    return firstConfiguredUrl(
      process.env.MODAL_MOSS_OPENMOSS_TTS_URL,
      allowGenericFallback ? process.env.MODAL_TTS_URL : undefined
    );
  }
  return firstConfiguredUrl(
    process.env.MODAL_MOSS_DELAY_TTS_URL,
    process.env.MODAL_MOSS_TTS_URL,
    (allowGenericFallback ? process.env.MODAL_TTS_URL : undefined)
  );
}

export function isShortTtsJob(size?: TtsJobSize): boolean {
  const configuredThreshold = Number(process.env.MOSS_SHORT_JOB_CHAR_THRESHOLD);
  const threshold =
    Number.isFinite(configuredThreshold) && configuredThreshold > 0
      ? configuredThreshold
      : DEFAULT_SHORT_JOB_CHAR_THRESHOLD;
  const charCount = size?.charCount;
  const paragraphCount = size?.paragraphCount;

  if (typeof charCount === "number" && charCount >= 0) {
    return charCount <= threshold;
  }
  return typeof paragraphCount === "number" && paragraphCount >= 0
    ? paragraphCount <= 1
    : false;
}

/**
 * New preview and audiobook jobs use the flagship SGLang route by default.
 * Persisted `audiobookVariant` keeps retries on the same backend.
 * When rolled back to Delay, short jobs still prefer SGLang for latency.
 */
export function resolveTtsRoute(
  context: TtsRoutingContext,
  size?: TtsJobSize,
  audiobookVariant?: MossAbVariant | null
): TtsRoute {
  const isShortJob = context === "preview" || isShortTtsJob(size);
  const configured = resolveMossAbVariant();
  const variant =
    context === "preview"
      ? "sglang"
      : audiobookVariant ??
        (configured !== "sglang" && isShortJob ? "sglang" : configured);
  const allowGenericFallback = variant === "sglang" && isShortJob;

  return {
    variant,
    batchUrl: resolveMossBatchUrl(variant, allowGenericFallback),
    isShortJob,
  };
}

export function resolveModalBatchUrl(variant?: MossAbVariant): string | undefined {
  return resolveMossBatchUrl(variant);
}

export function resolveModalBaseUrl(variant?: MossAbVariant): string | undefined {
  const batch = resolveModalBatchUrl(variant);
  return batch?.replace(MOSS_BATCH_SUFFIX, "");
}
