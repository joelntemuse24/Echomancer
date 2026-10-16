/**
 * Section audio → mono 48 kHz 16-bit WAV.
 * Trims edges quieter than −40 dB, caps the take at 40 s, then reuses
 * prepareClonePcm (−20 LUFS, gain only). Silent or sub-8 s audio is rejected.
 */

import { clipDurationMatches, clampClipLength } from "@/lib/youtube/clip-policy";
import { prepareClonePcm } from "@/lib/tts/clone-sample-prepare";
import { floatToWavBytes } from "@/lib/youtube/wav-bytes";

const RATE = 48_000;
const MIN_SAMPLES = 8 * RATE;
const MAX_SAMPLES = 40 * RATE;
const SILENCE_RMS = 10 ** (-40 / 20);
const DEAD_RMS = 1e-4;

export type MasteredClip =
  | { ok: true; wav: Buffer }
  | { ok: false; code: "unusable_audio" | "range_unsupported" };

function trimBelowDb(samples: Float32Array, sampleRate: number): Float32Array {
  const frame = Math.max(1, Math.round(sampleRate * 0.02));
  let first = -1;
  let last = -1;
  for (let i = 0; i + frame <= samples.length; i += frame) {
    let energy = 0;
    for (let j = 0; j < frame; j++) {
      const s = samples[i + j]!;
      energy += s * s;
    }
    if (Math.sqrt(energy / frame) < SILENCE_RMS) continue;
    if (first < 0) first = i;
    last = i + frame;
  }
  if (first < 0 || last < 0) return new Float32Array(0);
  const pad = Math.round(sampleRate * 0.05);
  return samples.subarray(Math.max(0, first - pad), Math.min(samples.length, last + pad));
}

function rms(samples: Float32Array): number {
  if (!samples.length) return 0;
  let energy = 0;
  for (let i = 0; i < samples.length; i++) energy += samples[i]! * samples[i]!;
  return Math.sqrt(energy / samples.length);
}

export function masterClipPcm(samples: Float32Array, sampleRate = RATE, requestedSeconds?: number): MasteredClip {
  if (requestedSeconds != null && !clipDurationMatches(samples.length / sampleRate, clampClipLength(requestedSeconds))) {
    return { ok: false, code: "range_unsupported" };
  }
  const maxSamples = requestedSeconds == null ? MAX_SAMPLES : Math.floor(clampClipLength(requestedSeconds) * sampleRate);
  let pcm = trimBelowDb(samples, sampleRate);
  if (pcm.length > maxSamples) pcm = pcm.subarray(0, maxSamples);
  if (pcm.length < MIN_SAMPLES || rms(pcm) < DEAD_RMS) {
    return { ok: false, code: "unusable_audio" };
  }
  const prepared = prepareClonePcm(pcm, sampleRate);
  if (prepared.samples.length < MIN_SAMPLES) {
    return { ok: false, code: "unusable_audio" };
  }
  const capped =
    prepared.samples.length > maxSamples
      ? prepared.samples.subarray(0, maxSamples)
      : prepared.samples;
  return { ok: true, wav: Buffer.from(floatToWavBytes(capped, sampleRate)) };
}
