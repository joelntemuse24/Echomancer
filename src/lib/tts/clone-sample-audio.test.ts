import { describe, expect, it } from "vitest";
import { pcmToWav, stripWavHeader } from "./pcm-wav";
import {
  cleanupCloneSample,
  highPassPcm,
  noiseGatePcm,
  normalizePeakPcm,
  parseWavPcm,
} from "./clone-sample-audio";

const SAMPLE_RATE = 16_000;

function sine(
  seconds: number,
  freq: number,
  amplitude: number,
  sampleRate = SAMPLE_RATE
): Float32Array {
  const n = Math.floor(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return out;
}

function mix(...parts: Float32Array[]): Float32Array {
  const n = Math.max(...parts.map((p) => p.length));
  const out = new Float32Array(n);
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) out[i]! += part[i]!;
  }
  return out;
}

function floatToInt16(samples: Float32Array): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]!));
    buf.writeInt16LE(Math.round(x * 32767), i * 2);
  }
  return buf;
}

function int16ToFloat(pcm: Buffer): Float32Array {
  const n = Math.floor(pcm.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2) / 32768;
  return out;
}

function goertzelEnergy(
  samples: Float32Array,
  sampleRate: number,
  freq: number
): number {
  const omega = (2 * Math.PI * freq) / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    s0 = samples[i]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return Math.sqrt(Math.max(0, power)) / samples.length;
}

function peak(samples: Float32Array): number {
  let m = 0;
  for (let i = 0; i < samples.length; i++) m = Math.max(m, Math.abs(samples[i]!));
  return m;
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / Math.max(1, samples.length));
}

describe("clone-sample-audio", () => {
  it("parses a PCM wav written by pcmToWav", () => {
    const pcm = floatToInt16(sine(0.05, 440, 0.5));
    const wav = pcmToWav(pcm, { sampleRate: SAMPLE_RATE, numChannels: 1, bitDepth: 16 });
    const parsed = parseWavPcm(wav);
    expect(parsed).not.toBeNull();
    expect(parsed!.sampleRate).toBe(SAMPLE_RATE);
    expect(parsed!.numChannels).toBe(1);
    expect(parsed!.pcm.length).toBe(pcm.length);
  });

  it("high-pass filter cuts rumble harder than speech-band tone", () => {
    const rumble = sine(0.25, 50, 0.6);
    const voice = sine(0.25, 1000, 0.4);
    const mixed = mix(rumble, voice);
    const filtered = highPassPcm(mixed, SAMPLE_RATE, 80);

    const rumbleBefore = goertzelEnergy(mixed, SAMPLE_RATE, 50);
    const rumbleAfter = goertzelEnergy(filtered, SAMPLE_RATE, 50);
    const voiceBefore = goertzelEnergy(mixed, SAMPLE_RATE, 1000);
    const voiceAfter = goertzelEnergy(filtered, SAMPLE_RATE, 1000);

    expect(rumbleAfter).toBeLessThan(rumbleBefore * 0.35);
    expect(voiceAfter).toBeGreaterThan(voiceBefore * 0.7);
  });

  it("peak-normalizes a quiet clip toward a target level", () => {
    const quiet = sine(0.1, 1000, 0.1);
    const out = normalizePeakPcm(quiet, 0.89);
    expect(peak(out)).toBeGreaterThan(0.8);
    expect(peak(out)).toBeLessThanOrEqual(0.9);
  });

  it("noise gate reduces a quiet floor next to a louder burst", () => {
    const floor = new Float32Array(SAMPLE_RATE * 0.15);
    floor.fill(0.03);
    const burst = sine(0.1, 1000, 0.5);
    const clip = new Float32Array(floor.length + burst.length + floor.length);
    clip.set(floor, 0);
    clip.set(burst, floor.length);
    clip.set(floor, floor.length + burst.length);

    const gated = noiseGatePcm(clip, SAMPLE_RATE);
    const quietBefore = rms(clip.subarray(0, floor.length));
    const quietAfter = rms(gated.subarray(0, floor.length));
    const burstAfter = peak(
      gated.subarray(floor.length, floor.length + burst.length)
    );
    expect(quietAfter).toBeLessThan(quietBefore * 0.5);
    expect(burstAfter).toBeGreaterThan(0.35);
  });

  it("cleanupCloneSample processes a tiny wav fixture", () => {
    const rumble = sine(0.2, 40, 0.5);
    const voice = sine(0.2, 800, 0.2);
    const wav = pcmToWav(floatToInt16(mix(rumble, voice)), {
      sampleRate: SAMPLE_RATE,
      numChannels: 1,
      bitDepth: 16,
    });

    const result = cleanupCloneSample(wav, "sample.wav", "audio/wav");
    expect(result.processed).toBe(true);
    expect(result.reason).toBe("wav-pcm");
    expect(result.filename).toMatch(/\.wav$/i);
    expect(result.contentType).toMatch(/wav/i);
    expect(result.audio.toString("ascii", 0, 4)).toBe("RIFF");

    const parsed = parseWavPcm(result.audio);
    expect(parsed).not.toBeNull();
    const samples = int16ToFloat(parsed!.pcm);
    expect(goertzelEnergy(samples, parsed!.sampleRate, 40)).toBeLessThan(
      goertzelEnergy(int16ToFloat(stripWavHeader(wav)), SAMPLE_RATE, 40) * 0.5
    );
  });

  it("passes through undecodable compressed audio (no ffmpeg)", () => {
    // MPEG frame sync — not a WAV we can cheaply decode in-function.
    const mp3ish = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const result = cleanupCloneSample(mp3ish, "sample.mp3", "audio/mpeg");
    expect(result.processed).toBe(false);
    expect(result.reason).toBe("passthrough");
    expect(result.audio.equals(mp3ish)).toBe(true);
    expect(result.filename).toBe("sample.mp3");
  });
});
