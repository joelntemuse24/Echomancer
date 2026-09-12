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

  return {
    duration_s,
    clip_frac,
    speech_frac,
    speech_level_db,
    rt60_est_s: estimateRt60(frameDb, speech, FRAME_SEC),
    reverb_proxy: estimateReverbProxy(samples, sampleRate, speech, frameSize),
  };
}
