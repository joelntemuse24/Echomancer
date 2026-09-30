/**
 * Decide whether a clip is usable as a solo-speech clone sample.
 *
 * Tuned on synthetic signals (syllable-modulated formants, white noise,
 * two simultaneous pitches). Real clips still go through ffmpeg loudness
 * and an optional vocal-separation pass before this verdict is final.
 */

import { YOUTUBE_COPY } from "@/lib/youtube/messages";

export const MIN_SPEECH_SEC = 8;
const ANALYSIS_RATE = 16_000;
const FRAME = 256;
const HOP = 128;

export type SpeechRejectCode = "music" | "overlap" | "short_speech";

export type SpeechJudgement = {
  ok: boolean;
  code?: SpeechRejectCode;
  message?: string;
  speechSec: number;
  denoise: boolean;
  separateVocals: boolean;
  musicFraction: number;
  overlapFraction: number;
};

export function judgeSpeech(
  samples: Float32Array,
  sampleRate: number
): SpeechJudgement {
  const mono = sampleRate === ANALYSIS_RATE ? samples : downsample(samples, sampleRate, ANALYSIS_RATE);
  const empty: SpeechJudgement = {
    ok: false,
    code: "short_speech",
    message: YOUTUBE_COPY.shortSpeech,
    speechSec: 0,
    denoise: false,
    separateVocals: false,
    musicFraction: 0,
    overlapFraction: 0,
  };
  if (mono.length < FRAME * 4) return empty;

  const frameCount = Math.floor((mono.length - FRAME) / HOP) + 1;
  const rms = new Float32Array(frameCount);
  const speech = new Uint8Array(frameCount);
  const music = new Uint8Array(frameCount);
  const loud = new Uint8Array(frameCount);

  const rmsAll: number[] = [];
  for (let f = 0; f < frameCount; f++) {
    const offset = f * HOP;
    rms[f] = frameRms(mono, offset, FRAME);
    rmsAll.push(rms[f]!);
  }
  const noiseFloor = percentile(rmsAll, 0.15);
  const loudCut = Math.max(noiseFloor * 1.45, 0.008);

  let speechFrames = 0;
  let musicFrames = 0;
  let loudFrames = 0;
  const speechRms: number[] = [];

  for (let f = 0; f < frameCount; f++) {
    const offset = f * HOP;
    const level = rms[f]!;
    if (level < loudCut) continue;
    loud[f] = 1;
    loudFrames += 1;
    const zcr = frameZcr(mono, offset, FRAME);
    const mags = fftMag(windowFrame(mono, offset, FRAME));
    const flat = spectralFlatness(mags);
    const centroid = spectralCentroid(mags, ANALYSIS_RATE);
    const speechLike =
      zcr >= 0.02 &&
      zcr <= 0.2 &&
      flat < 0.38 &&
      centroid >= 90 &&
      centroid <= 3800;
    const musicLike = flat > 0.52 || (flat > 0.36 && zcr > 0.16 && centroid > 1800);
    if (speechLike) {
      speech[f] = 1;
      speechFrames += 1;
      speechRms.push(level);
    } else if (musicLike) {
      music[f] = 1;
      musicFrames += 1;
    }
  }

  const hopSec = HOP / ANALYSIS_RATE;
  const speechSec = speechFrames * hopSec;
  const musicFraction = loudFrames > 0 ? musicFrames / loudFrames : 0;
  const overlap = overlapFraction(mono, speech);
  const modulation = envelopeModulation(rms);
  const snrDb = speechRms.length
    ? 20 * Math.log10((median(speechRms) + 1e-8) / (noiseFloor + 1e-8))
    : 0;

  const base = {
    speechSec,
    denoise: snrDb > 0 && snrDb < 16,
    separateVocals: false,
    musicFraction,
    overlapFraction: overlap.fraction,
  };

  if (process.env.SPEECH_JUDGE_DEBUG === "1") {
    console.log(
      JSON.stringify({
        speechSec,
        musicFraction,
        noiseFloor,
        loudCut,
        loudFrames,
        speechFrames,
        musicFrames,
        frameCount,
        overlap,
        modulation,
        snrDb,
      })
    );
  }

  if (speechSec < MIN_SPEECH_SEC) {
    const stationaryNoise =
      loudFrames < frameCount * 0.08 &&
      median(rmsAll) > 0.02 &&
      stationaryFlatness(mono) > 0.5;
    if (
      stationaryNoise ||
      (musicFraction >= 0.4 && musicFrames >= speechFrames && musicFrames > 0)
    ) {
      return { ...base, ok: false, code: "music", message: YOUTUBE_COPY.music, denoise: false };
    }
    return { ...base, ok: false, code: "short_speech", message: YOUTUBE_COPY.shortSpeech, denoise: false };
  }

  if (overlap.fraction >= 0.3 && overlap.samples >= 4) {
    return { ...base, ok: false, code: "overlap", message: YOUTUBE_COPY.overlap, denoise: false };
  }

  if (musicFraction >= 0.62 && modulation < 0.15) {
    return { ...base, ok: false, code: "music", message: YOUTUBE_COPY.music, denoise: false };
  }

  const separateVocals = musicFraction >= 0.18;
  return {
    ...base,
    ok: true,
    denoise: base.denoise && !separateVocals,
    separateVocals,
  };
}

function stationaryFlatness(samples: Float32Array): number {
  const flats: number[] = [];
  const step = Math.max(HOP, Math.floor(samples.length / 12));
  for (let offset = 0; offset + FRAME < samples.length; offset += step) {
    if (frameRms(samples, offset, FRAME) < 0.01) continue;
    flats.push(spectralFlatness(fftMag(windowFrame(samples, offset, FRAME))));
  }
  return flats.length ? median(flats) : 0;
}

function downsample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate <= toRate) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

function frameRms(samples: Float32Array, offset: number, length: number): number {
  let sum = 0;
  const end = Math.min(samples.length, offset + length);
  const n = end - offset;
  if (n <= 0) return 0;
  for (let i = offset; i < end; i++) {
    const s = samples[i]!;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

function frameZcr(samples: Float32Array, offset: number, length: number): number {
  const end = Math.min(samples.length - 1, offset + length - 1);
  let crosses = 0;
  let n = 0;
  for (let i = offset; i < end; i++) {
    const a = samples[i]!;
    const b = samples[i + 1]!;
    if ((a >= 0 && b < 0) || (a < 0 && b >= 0)) crosses += 1;
    n += 1;
  }
  return n > 0 ? crosses / n : 0;
}

function windowFrame(samples: Float32Array, offset: number, length: number): Float32Array {
  const frame = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (length - 1)));
    frame[i] = (samples[offset + i] || 0) * hann;
  }
  return frame;
}

function fftMag(frame: Float32Array): Float32Array {
  const n = frame.length;
  const re = Float32Array.from(frame);
  const im = new Float32Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const theta = (-2 * Math.PI) / size;
    const wRe = Math.cos(theta);
    const wIm = Math.sin(theta);
    for (let i = 0; i < n; i += size) {
      let curRe = 1;
      let curIm = 0;
      for (let j = 0; j < half; j++) {
        const k = i + j;
        const l = k + half;
        const tRe = curRe * re[l]! - curIm * im[l]!;
        const tIm = curRe * im[l]! + curIm * re[l]!;
        re[l] = re[k]! - tRe;
        im[l] = im[k]! - tIm;
        re[k] = re[k]! + tRe;
        im[k] = im[k]! + tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
  const mags = new Float32Array(n / 2);
  for (let i = 0; i < mags.length; i++) mags[i] = Math.hypot(re[i]!, im[i]!);
  return mags;
}

function spectralFlatness(mags: Float32Array): number {
  let logSum = 0;
  let sum = 0;
  const n = mags.length;
  for (let i = 1; i < n; i++) {
    const m = mags[i]! + 1e-12;
    logSum += Math.log(m);
    sum += m;
  }
  const count = Math.max(1, n - 1);
  const geo = Math.exp(logSum / count);
  const arith = sum / count;
  return arith > 0 ? geo / arith : 1;
}

function spectralCentroid(mags: Float32Array, sampleRate: number): number {
  let num = 0;
  let den = 0;
  const bins = mags.length;
  for (let i = 1; i < bins; i++) {
    const freq = (i * sampleRate) / (bins * 2);
    num += freq * mags[i]!;
    den += mags[i]!;
  }
  return den > 0 ? num / den : 0;
}

function envelopeModulation(rms: Float32Array): number {
  const frameRate = ANALYSIS_RATE / HOP;
  const minLag = Math.max(1, Math.round(frameRate / 8));
  const maxLag = Math.min(rms.length - 2, Math.round(frameRate / 2));
  if (maxLag <= minLag) return 0;
  let mean = 0;
  for (let i = 0; i < rms.length; i++) mean += rms[i]!;
  mean /= rms.length;
  let energy = 0;
  for (let i = 0; i < rms.length; i++) {
    const d = rms[i]! - mean;
    energy += d * d;
  }
  if (energy <= 1e-8) return 0;
  let peak = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < rms.length - lag; i++) {
      sum += (rms[i]! - mean) * (rms[i + lag]! - mean);
    }
    peak = Math.max(peak, sum / energy);
  }
  return peak;
}

function overlapFraction(
  samples: Float32Array,
  speech: Uint8Array
): { fraction: number; samples: number } {
  let checked = 0;
  let dual = 0;
  const win = 1024;
  for (let f = 0; f < speech.length; f += 6) {
    if (!speech[f]) continue;
    const offset = f * HOP;
    if (offset + win >= samples.length) break;
    checked += 1;
    if (hasDualPitch(samples.subarray(offset, offset + win), ANALYSIS_RATE)) dual += 1;
  }
  return { fraction: checked > 0 ? dual / checked : 0, samples: checked };
}

function hasDualPitch(frame: Float32Array, sampleRate: number): boolean {
  const minLag = Math.floor(sampleRate / 400);
  const maxLag = Math.min(frame.length - 2, Math.floor(sampleRate / 70));
  if (maxLag <= minLag + 4) return false;
  let energy = 0;
  for (let i = 0; i < frame.length; i++) energy += frame[i]! * frame[i]!;
  if (energy < 1e-3) return false;

  const corr = new Float32Array(maxLag + 1);
  let best = 0;
  let bestLag = -1;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    const limit = frame.length - lag;
    for (let i = 0; i < limit; i += 2) sum += frame[i]! * frame[i + lag]!;
    const c = (sum * 2) / energy;
    corr[lag] = c;
    if (c > best) {
      best = c;
      bestLag = lag;
    }
  }
  if (best < 0.35 || bestLag < 0) return false;

  let second = 0;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    const c = corr[lag]!;
    if (c < corr[lag - 1]! || c < corr[lag + 1]!) continue;
    if (Math.abs(lag - bestLag) / bestLag < 0.08) continue;
    if (isHarmonicLag(lag, bestLag)) continue;
    if (c > second) second = c;
  }
  return second > best * 0.55;
}

function isHarmonicLag(lag: number, bestLag: number): boolean {
  const ratio = lag / bestLag;
  for (const harmonic of [0.5, 2, 3, 1 / 3]) {
    if (Math.abs(ratio - harmonic) / harmonic < 0.1) return true;
  }
  return false;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx]!;
}

function median(values: number[]): number {
  return percentile(values, 0.5);
}

/** Int16 PCM (interleaved) → mono float in -1..1. */
export function pcm16ToMonoFloat(pcm: Buffer, channels: number): Float32Array {
  const safeChannels = Math.max(1, channels);
  const frames = Math.floor(pcm.length / 2 / safeChannels);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < safeChannels; c++) {
      sum += pcm.readInt16LE((i * safeChannels + c) * 2) / 32768;
    }
    out[i] = sum / safeChannels;
  }
  return out;
}
