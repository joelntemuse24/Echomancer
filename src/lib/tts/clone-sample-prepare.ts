/**
 * Trim silence and set level before a clone upload.
 * Gain only: no gate, no denoise. Client-safe.
 */

import type { CloneSampleMetrics } from "@/lib/tts/clone-sample-quality";
import { measureCloneSamplePcm } from "@/lib/tts/clone-sample-quality-metrics";

export const CLONE_TARGET_LUFS = -20;
const FRAME_SEC = 0.02;
const PAD_SEC = 0.08;
const PEAK_LIMIT = 0.98;

export type PreparedClonePcm = {
  samples: Float32Array;
  sampleRate: number;
  metrics: CloneSampleMetrics;
};

function biquad(
  samples: Float32Array,
  b0: number,
  b1: number,
  b2: number,
  a1: number,
  a2: number
): Float32Array {
  const out = new Float32Array(samples.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i]!;
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

/** ITU-R BS.1770 K-weighting, coefficients from the sample rate. */
function kWeight(samples: Float32Array, sampleRate: number): Float32Array {
  const shelfF = 1681.974450955533;
  const shelfG = 3.999843853973347;
  const shelfQ = 0.7071752369554196;
  const kShelf = Math.tan((Math.PI * shelfF) / sampleRate);
  const vh = 10 ** (shelfG / 20);
  const vb = vh ** 0.4996667741545416;
  const a0s = 1 + kShelf / shelfQ + kShelf * kShelf;
  const shelved = biquad(
    samples,
    (vh + (vb * kShelf) / shelfQ + kShelf * kShelf) / a0s,
    (2 * (kShelf * kShelf - vh)) / a0s,
    (vh - (vb * kShelf) / shelfQ + kShelf * kShelf) / a0s,
    (2 * (kShelf * kShelf - 1)) / a0s,
    (1 - kShelf / shelfQ + kShelf * kShelf) / a0s
  );

  const hpF = 38.13547087602444;
  const hpQ = 0.5003270373238773;
  const kHp = Math.tan((Math.PI * hpF) / sampleRate);
  const a0h = 1 + kHp / hpQ + kHp * kHp;
  return biquad(
    shelved,
    1 / a0h,
    -2 / a0h,
    1 / a0h,
    (2 * (kHp * kHp - 1)) / a0h,
    (1 - kHp / hpQ + kHp * kHp) / a0h
  );
}

function meanSquare(samples: Float32Array, start: number, end: number): number {
  let e = 0;
  const n = Math.max(1, end - start);
  for (let i = start; i < end; i++) e += samples[i]! * samples[i]!;
  return e / n;
}

/** Integrated loudness. Null when the clip is silent. */
export function integratedLufs(samples: Float32Array, sampleRate: number): number | null {
  if (samples.length < sampleRate * 0.4 || sampleRate < 1_000) return null;
  const weighted = kWeight(samples, sampleRate);
  const block = Math.round(0.4 * sampleRate);
  const hop = Math.round(0.1 * sampleRate);
  const blocks: number[] = [];
  for (let i = 0; i + block <= weighted.length; i += hop) {
    blocks.push(meanSquare(weighted, i, i + block));
  }
  if (!blocks.length) return null;
  const absGate = 10 ** ((-70 + 0.691) / 10);
  const above = blocks.filter((ms) => ms > absGate);
  if (!above.length) return null;
  const ungated = above.reduce((sum, ms) => sum + ms, 0) / above.length;
  const relGate = ungated * 10 ** (-10 / 10);
  const gated = above.filter((ms) => ms > relGate);
  const mean = (gated.length ? gated : above).reduce((sum, ms) => sum + ms, 0) /
    (gated.length || above.length);
  if (!(mean > 0)) return null;
  return -0.691 + 10 * Math.log10(mean);
}

function frameDb(samples: Float32Array, sampleRate: number): Float64Array {
  const frame = Math.max(1, Math.round(sampleRate * FRAME_SEC));
  const n = Math.floor(samples.length / frame);
  const out = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    const ms = meanSquare(samples, f * frame, (f + 1) * frame);
    out[f] = 10 * Math.log10(Math.max(ms, 1e-16));
  }
  return out;
}

function trimToSpeech(samples: Float32Array, sampleRate: number): Float32Array {
  const db = frameDb(samples, sampleRate);
  if (db.length < 4) return samples;
  const sorted = Array.from(db).sort((a, b) => a - b);
  const noise = sorted[Math.floor(0.2 * (sorted.length - 1))]!;
  const thresh = Math.max(noise + 8, -40);
  let first = -1;
  let last = -1;
  for (let i = 0; i < db.length; i++) {
    if (db[i]! > thresh) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0 || last < 0) return samples;
  const frame = Math.max(1, Math.round(sampleRate * FRAME_SEC));
  const pad = Math.round(PAD_SEC * sampleRate);
  const start = Math.max(0, first * frame - pad);
  const end = Math.min(samples.length, (last + 1) * frame + pad);
  if (end - start >= samples.length - frame) return samples;
  return samples.subarray(start, end);
}

function gainToLufs(
  samples: Float32Array,
  sampleRate: number,
  target: number
): Float32Array {
  const lufs = integratedLufs(samples, sampleRate);
  if (lufs == null || !Number.isFinite(lufs)) return samples;
  let gain = 10 ** ((target - lufs) / 20);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]!));
  if (peak > 0 && peak * gain > PEAK_LIMIT) gain = PEAK_LIMIT / peak;
  if (Math.abs(gain - 1) < 0.02) return samples;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i]! * gain;
  return out;
}

/** Trim leading and trailing silence, then one gain toward −20 LUFS. */
export function prepareClonePcm(
  samples: Float32Array,
  sampleRate: number
): PreparedClonePcm {
  const trimmed = trimToSpeech(samples, sampleRate);
  const gained = gainToLufs(trimmed, sampleRate, CLONE_TARGET_LUFS);
  return {
    samples: gained,
    sampleRate,
    metrics: measureCloneSamplePcm(gained, sampleRate),
  };
}
