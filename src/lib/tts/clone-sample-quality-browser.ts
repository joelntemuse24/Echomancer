/**
 * Browser-only decode. Web Audio handles mp3, m4a, and webm, which is
 * faster than a server ffmpeg pass and stays off the Vercel request.
 * The prepared WAV is what we upload. The server remeasures that WAV.
 */

import { evaluateCloneSampleQuality, type CloneSampleQualityReport } from "@/lib/tts/clone-sample-quality";
import { prepareClonePcm } from "@/lib/tts/clone-sample-prepare";
import { floatToWavBytes } from "@/lib/youtube/wav-bytes";

type BrowserAudioContext = {
  decodeAudioData: (data: ArrayBuffer) => Promise<AudioBuffer>;
  close: () => Promise<void>;
};

function audioContextCtor(): (new (opts?: { sampleRate?: number }) => BrowserAudioContext) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: new (opts?: { sampleRate?: number }) => BrowserAudioContext;
    webkitAudioContext?: new (opts?: { sampleRate?: number }) => BrowserAudioContext;
  };
  return w.AudioContext || w.webkitAudioContext || null;
}

function openContext(Ctor: new (opts?: { sampleRate?: number }) => BrowserAudioContext): BrowserAudioContext {
  try {
    return new Ctor({ sampleRate: 48_000 });
  } catch {
    return new Ctor();
  }
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

export type PreparedCloneFile = {
  file: File;
  report: CloneSampleQualityReport | null;
  prepareMs: number;
};

export async function analyzeCloneSampleFile(
  file: File
): Promise<CloneSampleQualityReport | null> {
  const prepared = await prepareCloneSampleFile(file);
  return prepared.report;
}

/**
 * Decode, trim silence, and set about −20 LUFS. On failure the original
 * file is returned and the clone still proceeds.
 */
export async function prepareCloneSampleFile(file: File): Promise<PreparedCloneFile> {
  const started = typeof performance !== "undefined" ? performance.now() : Date.now();
  const Ctor = audioContextCtor();
  if (!Ctor) return { file, report: null, prepareMs: 0 };
  const ctx = openContext(Ctor);
  try {
    const raw = await file.arrayBuffer();
    const audio = await ctx.decodeAudioData(raw.slice(0));
    const prepared = prepareClonePcm(mixToMono(audio), audio.sampleRate);
    const wav = floatToWavBytes(prepared.samples, prepared.sampleRate);
    const copy = new Uint8Array(wav.byteLength);
    copy.set(wav);
    const next = new File([copy], "sample.wav", { type: "audio/wav" });
    const prepareMs = Math.round(
      (typeof performance !== "undefined" ? performance.now() : Date.now()) - started
    );
    console.info(`[clone] prepare ms=${prepareMs} bytes=${next.size}`);
    return {
      file: next,
      report: evaluateCloneSampleQuality(prepared.metrics),
      prepareMs,
    };
  } catch {
    return {
      file,
      report: null,
      prepareMs: Math.round(
        (typeof performance !== "undefined" ? performance.now() : Date.now()) - started
      ),
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}
