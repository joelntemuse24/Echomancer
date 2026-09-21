/**
 * Whole-book mastering gate + fail-open wrapper.
 *
 * Default remaster is ffmpeg-only: phone "Smooth" EQ (warm low-mids,
 * soft high cut) + EBU loudnorm, 44.1 kHz ~192 kbps MP3. DeepFilterNet3
 * is opt-in (`TTS_MASTER_DFN=1` and/or `TTS_MASTER_DFN_WET>0`). Only on
 * the always-on VM worker (or Trigger fallback). Live Listen / preview /
 * clone POST never call this. Cue tags are already on the frozen
 * speakable; this pass does not retag. The spawn pipeline lives in
 * `mastering-worker.ts` and is loaded with a dynamic import that Next is
 * told to ignore.
 */

export type MasterableAudioFormat = {
  extension: "mp3" | "wav" | "ogg";
  contentType: string;
};

/**
 * DeepFilterNet3 wet mix when explicitly enabled (`TTS_MASTER_DFN=1`
 * without a wet override). Lighter than 70/30 so clean TTS does not
 * sound washed. Default remaster skips DFN (wet 0).
 */
export const MASTER_BLEND_ENHANCED = 0.4;
/** Dry concat mix. */
export const MASTER_BLEND_DRY = 0.6;
/** ffmpeg loudnorm integrated loudness (LUFS). Audiobook-typical. */
export const MASTER_LOUDNORM_I = -18;
/** ffmpeg loudnorm true peak (dBTP). */
export const MASTER_LOUDNORM_TP = -1.5;
/**
 * ffmpeg loudnorm loudness range. Kept at 11 (audiobook-typical): phone
 * Smooth is spectral balance, not more dynamics, so a higher LRA would
 * not make the EQ warmer and would leave section-to-section TTS swing
 * less even after the low-mid lift.
 */
export const MASTER_LOUDNORM_LRA = 11;
/** Final Whole-book sample rate. */
export const MASTER_OUTPUT_SAMPLE_RATE = 44_100;
/** Final Whole-book MP3 bitrate (CBR-ish). */
export const MASTER_OUTPUT_MP3_BITRATE = "192k";
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
  if (env.WORKER === "1") return true;
  if (env.TTS_MASTER_FULL_BOOK === "1") return true;
  // Trigger Cloud does not inject TRIGGER=1; the deploy layer sets this.
  if (env.DEEP_FILTER_BIN) return true;
  return false;
}

/** ffmpeg filter_complex for the opt-in DFN blend + Smooth loudness chain. */
export function masterBlendFilterComplex(
  wet: number = MASTER_BLEND_ENHANCED,
  dry: number = MASTER_BLEND_DRY
): string {
  return [
    `[0:a]volume=${wet}[e]`,
    `[1:a]volume=${dry}[d]`,
    `[e][d]amix=inputs=2:duration=first:normalize=0:dropout_transition=0[mix]`,
    `[mix]${masterProfessionalAf()}[out]`,
  ].join(";");
}

/**
 * Phone "Smooth" EQ + EBU loudnorm. Applied on every remaster, including
 * the default ffmpeg-only path.
 *
 * - highpass 70 Hz — kill rumble without thinning speech
 * - two peaking lifts approximating 125 Hz ~+3, 250 Hz ~+4, 500 Hz ~+2
 * - soft high cut: ~8 kHz −3, ~14 kHz −4.5 (replaces −1.5@6.5 kHz)
 */
export function masterProfessionalAf(): string {
  return [
    "highpass=f=70",
    "equalizer=f=200:width_type=o:width=1.8:g=3.2",
    "equalizer=f=450:width_type=o:width=1.0:g=1.5",
    "equalizer=f=8000:width_type=o:width=1.2:g=-3",
    "equalizer=f=14000:width_type=h:width=4000:g=-4.5",
    `loudnorm=I=${MASTER_LOUDNORM_I}:TP=${MASTER_LOUDNORM_TP}:LRA=${MASTER_LOUDNORM_LRA}`,
  ].join(",");
}

export function masterEncodeArgs(format: MasterableAudioFormat): string[] {
  const rate = ["-ar", String(MASTER_OUTPUT_SAMPLE_RATE)];
  if (format.extension === "wav") return [...rate, "-c:a", "pcm_s16le"];
  if (format.extension === "ogg") {
    return [...rate, "-c:a", "libvorbis", "-b:a", MASTER_OUTPUT_MP3_BITRATE];
  }
  return [
    ...rate,
    "-c:a",
    "libmp3lame",
    "-b:a",
    MASTER_OUTPUT_MP3_BITRATE,
  ];
}

/**
 * DFN wet mix. Default 0 (ffmpeg-only remaster). Set `TTS_MASTER_DFN=1`
 * to use `MASTER_BLEND_ENHANCED` (0.4), or `TTS_MASTER_DFN_WET` (0–1) to
 * pin the mix. An explicit wet of 0 skips DFN even when `TTS_MASTER_DFN=1`.
 */
export function masterDenoiseWet(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.TTS_MASTER_DFN_WET;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  }
  if (env.TTS_MASTER_DFN === "1") return MASTER_BLEND_ENHANCED;
  return 0;
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
