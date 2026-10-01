/**
 * Lightweight PCM metrics for the clone-sample quality gate.
 *
 * Shared by Node and the browser: pass mono float samples (Web Audio or a
 * parsed WAV). No ffmpeg. Server WAV decode lives in
 * `clone-sample-quality-analyze.ts` so this file stays Buffer-free.
 */

import type { CloneSampleMetrics } from "@/lib/tts/clone-sample-quality";

const FRAME_SEC = 0.02;
const CLIP_ABS = 0.99;
const MIN_RMS = 1e-8;
const SPEECH_NOISE_MARGIN_DB = 8;
const SPEECH_ABS_MIN_DB = -40;

function dbFromRms(rms: number): number {
  return 20 * Math.log10(Math.max(rms, MIN_RMS));
}

function rmsRange(samples: Float32Array, start: number, end: number): number {
  const a = Math.max(0, start);
  const b = Math.min(samples.length, end);
  if (b <= a) return 0;
  let e = 0;
  for (let i = a; i < b; i++) e += samples[i]! * samples[i]!;
  return Math.sqrt(e / (b - a));
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return -80;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[i]!;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function linRegSlope(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 4) return null;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i]!;
    const y = ys[i]!;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-12) return null;
  return (n * sumXY - sumX * sumY) / denom;
}

function estimateRt60(
  frameDb: Float32Array,
  speech: boolean[],
  frameSec: number
): number | null {
  const estimates: number[] = [];
  const maxFrames = Math.floor(2.2 / frameSec);

  for (let i = 1; i < speech.length; i++) {
    if (!(speech[i - 1] && !speech[i])) continue;
    const startDb = frameDb[i - 1]!;
    let end = i;
    while (end < speech.length && end - i < maxFrames && !speech[end]) {
      end += 1;
    }
    if (end <= i) continue;

    const target20 = startDb - 20;
    let hit20 = -1;
    for (let f = i; f < end; f++) {
      if (frameDb[f]! <= target20) {
        hit20 = f;
        break;
      }
    }
    if (hit20 >= 0) {
      const dt = (hit20 - (i - 1)) * frameSec;
      if (dt > 0) estimates.push((dt * 60) / 20);
      continue;
    }

    const xs: number[] = [];
    const ys: number[] = [];
    for (let f = i; f < end; f++) {
      xs.push((f - i) * frameSec);
      ys.push(frameDb[f]!);
    }
    const slope = linRegSlope(xs, ys);
    if (slope != null && slope < -2) {
      estimates.push(-60 / slope);
    }
  }

  const mid = median(estimates);
  if (mid == null || !Number.isFinite(mid) || mid <= 0) return null;
  return Math.min(8, mid);
}

function estimateReverbProxy(
  samples: Float32Array,
  sampleRate: number,
  speech: boolean[],
  frameSize: number
): number {
  const earlyN = Math.round(0.03 * sampleRate);
  const lateStart = Math.round(0.08 * sampleRate);
  const lateEnd = Math.round(0.2 * sampleRate);
  const ratios: number[] = [];

  for (let f = 1; f < speech.length; f++) {
    if (!(speech[f - 1] && !speech[f])) continue;
    const offset = f * frameSize;
    if (offset + lateEnd > samples.length) continue;
    const early = rmsRange(samples, offset, offset + earlyN);
    const late = rmsRange(samples, offset + lateStart, offset + lateEnd);
    ratios.push(late / (early + MIN_RMS));
  }

  if (!ratios.length) {
    const hop = Math.max(1, Math.round(0.04 * sampleRate));
    const win = Math.round(0.03 * sampleRate);
    for (let i = hop; i + lateEnd < samples.length; i += hop) {
      const here = rmsRange(samples, i, i + win);
      const prev = rmsRange(samples, i - hop, i - hop + win);
      const next = rmsRange(samples, i + hop, i + hop + win);
      if (here < 0.02 || here < prev || here < next) continue;
      const late = rmsRange(samples, i + lateStart, i + lateEnd);
      ratios.push(late / (here + MIN_RMS));
    }
  }

  return median(ratios) ?? 0;
}

const SPECTRUM_N = 2048;

function bitReverseFft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const uRe = re[i + k]!;
        const uIm = im[i + k]!;
        const vRe = re[i + k + half]! * wRe - im[i + k + half]! * wIm;
        const vIm = re[i + k + half]! * wIm + im[i + k + half]! * wRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + half] = uRe - vRe;
        im[i + k + half] = uIm - vIm;
        const nextRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nextRe;
      }
    }
  }
}

/** Hertz under which 95% of the windowed energy sits. */
function energyHz95(samples: Float32Array, sampleRate: number): number | null {
  if (samples.length < SPECTRUM_N || sampleRate < 1_000) return null;
  const hann = new Float32Array(SPECTRUM_N);
  for (let i = 0; i < SPECTRUM_N; i++) {
    hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (SPECTRUM_N - 1)));
  }
  const bins = SPECTRUM_N / 2;
  const acc = new Float64Array(bins);
  const windows = 48;
  const span = Math.max(0, samples.length - SPECTRUM_N);
  const step = Math.max(SPECTRUM_N, Math.floor(span / Math.max(1, windows - 1)) || SPECTRUM_N);
  const re = new Float64Array(SPECTRUM_N);
  const im = new Float64Array(SPECTRUM_N);
  let used = 0;
  for (let start = 0; start + SPECTRUM_N <= samples.length && used < windows; start += step) {
    let energy = 0;
    for (let i = 0; i < SPECTRUM_N; i++) {
      const s = samples[start + i]!;
      energy += s * s;
      re[i] = s * hann[i]!;
      im[i] = 0;
    }
    if (energy < 1e-8 * SPECTRUM_N) continue;
    bitReverseFft(re, im);
    for (let k = 1; k < bins; k++) {
      acc[k] = (acc[k] ?? 0) + re[k]! * re[k]! + im[k]! * im[k]!;
    }
    used += 1;
  }
  if (!used) return null;
  let total = 0;
  for (let k = 1; k < bins; k++) total += acc[k]!;
  if (total <= 0) return null;
  let cum = 0;
  const target = total * 0.95;
  for (let k = 1; k < bins; k++) {
    cum += acc[k]!;
    if (cum >= target) return (k * sampleRate) / SPECTRUM_N;
  }
  return sampleRate / 2;
}

export function measureCloneSamplePcm(
  samples: Float32Array,
  sampleRate: number
): CloneSampleMetrics {
  const n = samples.length;
  const duration_s = sampleRate > 0 ? n / sampleRate : 0;

  let clip = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(samples[i]!) >= CLIP_ABS) clip += 1;
  }
  const clip_frac = n > 0 ? clip / n : 0;

  const frameSize = Math.max(1, Math.round(sampleRate * FRAME_SEC));
  const nFrames = Math.floor(n / frameSize);
  const frameDb = new Float32Array(nFrames);
  const frameRms = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    const r = rmsRange(samples, f * frameSize, f * frameSize + frameSize);
    frameRms[f] = r;
    frameDb[f] = dbFromRms(r);
  }

  const sortedDb = Array.from(frameDb).sort((a, b) => a - b);
  const noiseFloor = percentile(sortedDb, 0.2);
  const speechThresh = Math.max(noiseFloor + SPEECH_NOISE_MARGIN_DB, SPEECH_ABS_MIN_DB);

  const speech = new Array<boolean>(nFrames);
  let speechEnergy = 0;
  let speechCount = 0;
  for (let f = 0; f < nFrames; f++) {
    const isSpeech = frameDb[f]! > speechThresh;
    speech[f] = isSpeech;
    if (isSpeech) {
      speechEnergy += frameRms[f]! * frameRms[f]!;
      speechCount += 1;
    }
  }

  const speech_frac = nFrames > 0 ? speechCount / nFrames : 0;
  const speech_level_db = speechCount
    ? dbFromRms(Math.sqrt(speechEnergy / speechCount))
    : -80;
  const speech_bg_gap_db = speechCount ? speech_level_db - noiseFloor : null;

  return {
    duration_s,
    clip_frac,
    speech_frac,
    speech_level_db,
    rt60_est_s: estimateRt60(frameDb, speech, FRAME_SEC),
    reverb_proxy: estimateReverbProxy(samples, sampleRate, speech, frameSize),
    energy_hz_95: energyHz95(samples, sampleRate),
    speech_bg_gap_db,
  };
}
