/**
 * Browser-only decode + quality check. Uses Web Audio so mp3/m4a/webm work
 * without shipping ffmpeg. The server still re-checks 16-bit WAV bytes.
 */

import { evaluateCloneSampleQuality, type CloneSampleQualityReport } from "@/lib/tts/clone-sample-quality";
import { measureCloneSamplePcm } from "@/lib/tts/clone-sample-quality-metrics";

type BrowserAudioContext = {
  decodeAudioData: (data: ArrayBuffer) => Promise<AudioBuffer>;
  close: () => Promise<void>;
};

function audioContextCtor(): (new () => BrowserAudioContext) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: new () => BrowserAudioContext;
    webkitAudioContext?: new () => BrowserAudioContext;
  };
  return w.AudioContext || w.webkitAudioContext || null;
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  const frames = buffer.length;
  const out = new Float32Array(frames);
  const channels = buffer.numberOfChannels;
  if (channels < 1) return out;
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < frames; i++) out[i]! += data[i]!;
  }
  if (channels > 1) {
    for (let i = 0; i < frames; i++) out[i]! /= channels;
  }
  return out;
}

export async function analyzeCloneSampleFile(
  file: File
): Promise<CloneSampleQualityReport | null> {
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  const ctx = new Ctor();
  try {
    const raw = await file.arrayBuffer();
    const audio = await ctx.decodeAudioData(raw.slice(0));
    const samples = mixToMono(audio);
    return evaluateCloneSampleQuality(
      measureCloneSamplePcm(samples, audio.sampleRate)
    );
  } catch {
    return null;
  } finally {
    await ctx.close().catch(() => {});
  }
}
