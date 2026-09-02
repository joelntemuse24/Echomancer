/**
 * Whole-book mastering gate + fail-open wrapper.
 *
 * The 70/30 DeepFilterNet3 blend runs once on the concatenated full book,
 * and only on the Trigger.dev worker. Live Listen / preview / clone POST
 * never call this. The spawn pipeline lives in `mastering-worker.ts` and
 * is loaded with a dynamic import that Next is told to ignore.
 */

export type MasterableAudioFormat = {
  extension: "mp3" | "wav" | "ogg";
  contentType: string;
};

/** DeepFilterNet3 wet mix (Joel 70/30). */
export const MASTER_BLEND_ENHANCED = 0.7;
/** Dry concat mix. */
export const MASTER_BLEND_DRY = 0.3;
/** ffmpeg loudnorm integrated loudness (LUFS). */
export const MASTER_LOUDNORM_I = -18;
/** ffmpeg loudnorm true peak (dBTP). */
export const MASTER_LOUDNORM_TP = -1.5;
/** Skip enhance for clips shorter than this (seconds). */
export const MASTER_MIN_DURATION_SECONDS = 2;
/** DFN3 processes this many seconds at a time so a full book fits in RAM. */
export const MASTER_DFN_CHUNK_SECONDS = 180;
/**
 * DFN3 STFT + lookahead delay at 48 kHz
 * (`fft_size - hop_size + lookahead * hop_size`, 960 / 480 / 2).
 * Used when chunking (per-chunk `--compensate-delay` would drop samples
 * at every cut).
 */
export const DFN3_DELAY_SAMPLES_48K = 1440;
/** CBR-ish bytes/sec used to estimate MP3/Ogg length (128 kbps). */
const ESTIMATED_COMPRESSED_BYTES_PER_SEC = 16_000;

export type MasterEnhanceFn = (
  buffer: Buffer,
  format: MasterableAudioFormat
) => Promise<Buffer>;

export type MasterResult = {
  buffer: Buffer;
  mastered: boolean;
  reason:
    | "ok"
    | "skipped-host"
    | "too-short"
    | "already-mastered"
    | "failed-open";
};

export function shouldAttemptMastering(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (env.TTS_MASTER_SKIP === "1") return false;
  // Never on Vercel — ffmpeg / deep-filter are not in the isolate image.
  if (env.VERCEL === "1") return false;
  if (env.TRIGGER === "1") return true;
  if (env.TTS_MASTER_FULL_BOOK === "1") return true;
  // Trigger Cloud does not inject TRIGGER=1; the deploy layer sets this.
  if (env.DEEP_FILTER_BIN) return true;
  return false;
}

/** ffmpeg filter_complex for the 70/30 blend + loudnorm. */
export function masterBlendFilterComplex(): string {
  return [
    `[0:a]volume=${MASTER_BLEND_ENHANCED}[e]`,
    `[1:a]volume=${MASTER_BLEND_DRY}[d]`,
    `[e][d]amix=inputs=2:duration=first:normalize=0:dropout_transition=0[mix]`,
    `[mix]loudnorm=I=${MASTER_LOUDNORM_I}:TP=${MASTER_LOUDNORM_TP}[out]`,
  ].join(";");
}

function isWavBuffer(buffer: Buffer): boolean {
  return (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WAVE"
  );
}

function wavDurationSeconds(buffer: Buffer): number | null {
  if (buffer.length < 44 || !isWavBuffer(buffer)) return null;

  let offset = 12;
  let sampleRate = 0;
  let numChannels = 0;
  let bitDepth = 0;
  let dataBytes = 0;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (id === "fmt " && size >= 16 && dataStart + 16 <= buffer.length) {
      numChannels = buffer.readUInt16LE(dataStart + 2);
      sampleRate = buffer.readUInt32LE(dataStart + 4);
      bitDepth = buffer.readUInt16LE(dataStart + 14);
    } else if (id === "data") {
      dataBytes = Math.max(0, Math.min(size, buffer.length - dataStart));
      break;
    }
    offset = dataStart + size + (size % 2);
  }

  const bytesPerSec = sampleRate * numChannels * (bitDepth / 8);
  if (bytesPerSec <= 0) return null;
  return dataBytes / bytesPerSec;
}

export function estimateAudioDurationSeconds(
  buffer: Buffer,
  format: Pick<MasterableAudioFormat, "extension">
): number | null {
  if (buffer.length === 0) return 0;
  if (format.extension === "wav" || isWavBuffer(buffer)) {
    return wavDurationSeconds(buffer);
  }
  return buffer.length / ESTIMATED_COMPRESSED_BYTES_PER_SEC;
}

async function loadWorkerEnhance(): Promise<MasterEnhanceFn> {
  const mod = await import(
    /* webpackIgnore: true */
    "./mastering-worker"
  );
  return mod.enhanceConcatenatedAudiobook;
}

/**
 * Apply the full-book master, or return the dry concat.
 * Enhance errors never throw — a finished book always ships.
 */
export async function applyFullBookMastering(
  buffer: Buffer,
  format: MasterableAudioFormat,
  opts?: {
    alreadyMastered?: boolean;
    enhance?: MasterEnhanceFn;
    logPrefix?: string;
  }
): Promise<MasterResult> {
  const logPrefix = opts?.logPrefix ?? "[master]";

  if (opts?.alreadyMastered) {
    return { buffer, mastered: false, reason: "already-mastered" };
  }

  const duration = estimateAudioDurationSeconds(buffer, format);
  if (duration !== null && duration < MASTER_MIN_DURATION_SECONDS) {
    return { buffer, mastered: false, reason: "too-short" };
  }

  if (!opts?.enhance && !shouldAttemptMastering()) {
    return { buffer, mastered: false, reason: "skipped-host" };
  }

  try {
    const enhance = opts?.enhance ?? (await loadWorkerEnhance());
    const out = await enhance(buffer, format);
    if (!out?.length) {
      throw new Error("mastering produced empty audio");
    }
    return { buffer: out, mastered: true, reason: "ok" };
  } catch (err) {
    console.error(
      `${logPrefix} mastering failed, shipping dry concat:`,
      err
    );
    return { buffer, mastered: false, reason: "failed-open" };
  }
}
