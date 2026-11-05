/**
 * Prepare a clone reference for Qwen voice enrollment.
 *
 * The best Flash clone came from a short, dense slice: ~6 s of continuous
 * speech, edges trimmed, small pads, peak 0.70, 24 kHz PCM16, Alibaba
 * preprocessing off. Longer or roomier references did not do better.
 */

import { pcmToWav } from "@/lib/tts/pcm-wav";
import {
  QWEN_SAMPLE_RATE,
  decodeToPcm16,
  frameLevelsDb,
  toFloat,
  toPcm16,
} from "@/lib/tts/qwen-join";

export const QWEN_REFERENCE_SECONDS = 6;
const FRAME_MS = 10;

export type ReferenceWindow = { startSeconds: number; endSeconds: number; speechFraction: number };

/**
 * Window of `seconds` with the most speech frames (within 30 dB of the loud
 * frames). Ties go to the window with the shortest inner pause.
 */
export function pickReferenceWindow(
  x: Float32Array,
  seconds = QWEN_REFERENCE_SECONDS,
  sampleRate = QWEN_SAMPLE_RATE
): ReferenceWindow {
  const e = frameLevelsDb(x, sampleRate, FRAME_MS);
  const total = x.length / sampleRate;
  const w = Math.round((seconds * 1000) / FRAME_MS);
  if (e.length <= w) return { startSeconds: 0, endSeconds: total, speechFraction: 1 };
  const sorted = Array.from(e).sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.95)]!;
  const speech = Array.from(e, (v) => (v > loud - 30 ? 1 : 0));
  const prefix = [0];
  for (const s of speech) prefix.push(prefix[prefix.length - 1]! + s);

  const longestPause = (a: number) => {
    let best = 0;
    let run = 0;
    for (let i = a; i < a + w; i++) {
      run = speech[i] ? 0 : run + 1;
      best = Math.max(best, run);
    }
    return best;
  };
  let bestStart = 0;
  let bestCount = -1;
  let bestPause = Infinity;
  const step = Math.max(1, Math.round(250 / FRAME_MS));
  for (let a = 0; a + w <= e.length; a += step) {
    const count = prefix[a + w]! - prefix[a]!;
    if (count < bestCount) continue;
    const pause = longestPause(a);
    if (count > bestCount || pause < bestPause) {
      bestStart = a;
      bestCount = count;
      bestPause = pause;
    }
  }
  return {
    startSeconds: (bestStart * FRAME_MS) / 1000,
    endSeconds: ((bestStart + w) * FRAME_MS) / 1000,
    speechFraction: bestCount / w,
  };
}

/** Trim to the speech inside the window, fade 10 ms, pad 120 ms, peak 0.70. */
export function shapeReference(x: Float32Array, sampleRate = QWEN_SAMPLE_RATE): Float32Array {
  const e = frameLevelsDb(x, sampleRate, FRAME_MS);
  const peakDb = Math.max(...Array.from(e));
  const frame = Math.round((sampleRate * FRAME_MS) / 1000);
  let a = 0;
  let b = e.length - 1;
  while (a < b && e[a]! < peakDb - 40) a++;
  while (b > a && e[b]! < peakDb - 40) b--;
  const lead = Math.max(0, (a - 2) * frame);
  const tail = Math.min(x.length, (b + 3) * frame);
  const core = x.slice(lead, tail);
  const fade = Math.min(Math.round(sampleRate * 0.01), Math.floor(core.length / 2));
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    core[i]! *= g;
    core[core.length - 1 - i]! *= g;
  }
  let peak = 0;
  for (const v of core) peak = Math.max(peak, Math.abs(v));
  const gain = peak > 0 ? 0.7 / peak : 1;
  const pad = Math.round(sampleRate * 0.12);
  const out = new Float32Array(core.length + pad * 2);
  for (let i = 0; i < core.length; i++) out[pad + i] = core[i]! * gain;
  return out;
}

export async function prepareQwenReference(
  audio: Buffer,
  opts: { seconds?: number } = {}
): Promise<{ wav: Buffer; window: ReferenceWindow; durationSeconds: number }> {
  const x = toFloat(await decodeToPcm16(audio));
  const window = pickReferenceWindow(x, opts.seconds ?? QWEN_REFERENCE_SECONDS);
  const slice = x.slice(
    Math.round(window.startSeconds * QWEN_SAMPLE_RATE),
    Math.round(window.endSeconds * QWEN_SAMPLE_RATE)
  );
  const shaped = shapeReference(slice);
  return {
    wav: pcmToWav(toPcm16(shaped), { sampleRate: QWEN_SAMPLE_RATE }),
    window,
    durationSeconds: shaped.length / QWEN_SAMPLE_RATE,
  };
}
