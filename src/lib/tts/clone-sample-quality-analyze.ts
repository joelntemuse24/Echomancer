/**
 * Server-side WAV quality check. 16-bit PCM only — compressed samples
 * return null so this stays off ffmpeg / wasm on the Vercel clone POST.
 */

import { parseWavPcm } from "@/lib/tts/clone-sample-audio";
import {
  evaluateCloneSampleQuality,
  type CloneSampleQualityReport,
} from "@/lib/tts/clone-sample-quality";
import { measureCloneSamplePcm } from "@/lib/tts/clone-sample-quality-metrics";

export function pcmBufferToMonoFloat(pcm: Buffer, numChannels: number): Float32Array {
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

/** 16-bit PCM WAV → quality report. Compressed audio returns null. */
export function analyzeCloneSampleBuffer(
  buf: Buffer
): CloneSampleQualityReport | null {
  const parsed = parseWavPcm(buf);
  if (!parsed) return null;
  const samples = pcmBufferToMonoFloat(parsed.pcm, parsed.numChannels);
  return evaluateCloneSampleQuality(
    measureCloneSamplePcm(samples, parsed.sampleRate)
  );
}
