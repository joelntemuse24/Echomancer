/**
 * Light CPU-only clone-sample cleanup for Vercel Hobby (`maxDuration` 60s).
 *
 * ffmpeg / ffmpeg.wasm stay off this function: they add tens of MB to the
 * serverless bundle, can blow Hobby time/memory, and must not land on the
 * Vercel hot path (Live Stream / preview / clone POST). We only touch PCM
 * we can parse as WAV via the existing `pcm-wav` helpers. Compressed
 * mp3/m4a/ogg pass through unchanged — prefer trimming/transcoding in the
 * browser later rather than decoding here. Fish still sets
 * `enhance_audio_quality`; this pass just high-pass / gate / normalize so
 * we copy less room tone into the clone.
 */

import { pcmToWav } from "@/lib/tts/pcm-wav";

export type CloneSampleCleanupReason = "wav-pcm" | "passthrough";

export type CloneSampleCleanupResult = {
  audio: Buffer;
  filename: string;
  contentType: string;
  processed: boolean;
  reason: CloneSampleCleanupReason;
};

export type ParsedWavPcm = {
  pcm: Buffer;
  sampleRate: number;
  numChannels: number;
  bitDepth: number;
};

/** Parse 16-bit PCM WAV. Anything else (mp3, m4a, float WAV) → null. */
export function parseWavPcm(buf: Buffer): ParsedWavPcm | null {
  if (buf.length < 44) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buf.toString("ascii", 8, 12) !== "WAVE") return null;

  let offset = 12;
  let sampleRate = 0;
  let numChannels = 0;
  let bitDepth = 0;
  let audioFormat = 0;
  let data: Buffer | null = null;

  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + size, buf.length);
    if (id === "fmt ") {
      if (size < 16 || start + 16 > buf.length) return null;
      audioFormat = buf.readUInt16LE(start);
      numChannels = buf.readUInt16LE(start + 2);
      sampleRate = buf.readUInt32LE(start + 4);
      bitDepth = buf.readUInt16LE(start + 14);
    } else if (id === "data") {
      data = buf.subarray(start, end);
    }
    offset = start + size + (size % 2);
  }

  if (!data || data.length < 2) return null;
  if (audioFormat !== 1 || bitDepth !== 16) return null;
  if (numChannels < 1 || numChannels > 8) return null;
  if (sampleRate < 8_000 || sampleRate > 192_000) return null;

  return { pcm: Buffer.from(data), sampleRate, numChannels, bitDepth };
}

function biquadHighPass(
  samples: Float32Array,
  sampleRate: number,
  cutoffHz: number
): Float32Array {
  const q = Math.SQRT1_2;
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cosw0 = Math.cos(w0);
  const sinw0 = Math.sin(w0);
  const alpha = sinw0 / (2 * q);
  const b0 = (1 + cosw0) / 2;
  const b1 = -(1 + cosw0);
  const b2 = (1 + cosw0) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw0;
  const a2 = 1 - alpha;
  const n0 = b0 / a0;
  const n1 = b1 / a0;
  const n2 = b2 / a0;
  const d1 = a1 / a0;
  const d2 = a2 / a0;

  const out = new Float32Array(samples.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i]!;
    const y0 = n0 * x0 + n1 * x1 + n2 * x2 - d1 * y1 - d2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

/** 4th-order high-pass (two cascaded biquads) — cheap rumble / room boom cut. */
export function highPassPcm(
  samples: Float32Array,
  sampleRate: number,
  cutoffHz = 100
): Float32Array {
  const safeCutoff = Math.min(Math.max(cutoffHz, 20), sampleRate / 4);
  const once = biquadHighPass(samples, sampleRate, safeCutoff);
  return biquadHighPass(once, sampleRate, safeCutoff);
}

/** Envelope follower + downward expansion on the quiet floor. */
export function noiseGatePcm(
  samples: Float32Array,
  sampleRate: number,
  threshold = 0.05
): Float32Array {
  const out = new Float32Array(samples.length);
  const attack = 1 - Math.exp(-1 / (0.005 * sampleRate));
  const release = 1 - Math.exp(-1 / (0.04 * sampleRate));
  let envelope = 0;
  let gain = 1;
  const closedGain = 0.02;
  for (let i = 0; i < samples.length; i++) {
    const x = Math.abs(samples[i]!);
    if (x > envelope) envelope += attack * (x - envelope);
    else envelope += release * (x - envelope);
    const target = envelope > threshold ? 1 : closedGain;
    if (target > gain) gain += attack * (target - gain);
    else gain += release * (target - gain);
    out[i] = samples[i]! * gain;
  }
  return out;
}

export function normalizePeakPcm(
  samples: Float32Array,
  targetPeak = 0.89
): Float32Array {
  let max = 0;
  for (let i = 0; i < samples.length; i++) {
    max = Math.max(max, Math.abs(samples[i]!));
  }
  if (max < 1e-6) return samples;
  const g = targetPeak / max;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i]! * g;
  return out;
}

function pcmBufferToMonoFloat(pcm: Buffer, numChannels: number): Float32Array {
  const frames = Math.floor(pcm.length / 2 / numChannels);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < numChannels; c++) {
      sum += pcm.readInt16LE((i * numChannels + c) * 2) / 32768;
    }
    out[i] = sum / numChannels;
  }
  return out;
}

function floatToInt16Pcm(samples: Float32Array): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]!));
    buf.writeInt16LE(Math.round(x * 32767), i * 2);
  }
  return buf;
}

function wavFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "") || "sample";
  return `${base}.wav`;
}

export function cleanupCloneSample(
  audio: Buffer,
  filename: string,
  contentType?: string
): CloneSampleCleanupResult {
  const parsed = parseWavPcm(audio);
  if (!parsed) {
    return {
      audio,
      filename,
      contentType: contentType || "application/octet-stream",
      processed: false,
      reason: "passthrough",
    };
  }

  let samples = pcmBufferToMonoFloat(parsed.pcm, parsed.numChannels);
  samples = highPassPcm(samples, parsed.sampleRate);
  samples = noiseGatePcm(samples, parsed.sampleRate);
  samples = normalizePeakPcm(samples);
  const wav = pcmToWav(floatToInt16Pcm(samples), {
    sampleRate: parsed.sampleRate,
    numChannels: 1,
    bitDepth: 16,
  });

  return {
    audio: wav,
    filename: wavFilename(filename),
    contentType: "audio/wav",
    processed: true,
    reason: "wav-pcm",
  };
}
