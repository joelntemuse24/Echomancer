import { describe, expect, it } from "vitest";
import { evaluateCloneSampleQuality } from "./clone-sample-quality";
import { analyzeCloneSampleBuffer } from "./clone-sample-quality-analyze";
import { measureCloneSamplePcm } from "./clone-sample-quality-metrics";
import { pcmToWav } from "./pcm-wav";

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

function concat(...parts: Float32Array[]): Float32Array {
  const n = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Float32Array(n);
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}

function silence(seconds: number, sampleRate = SAMPLE_RATE): Float32Array {
  return new Float32Array(Math.floor(seconds * sampleRate));
}

function applyDecay(samples: Float32Array, sampleRate: number, rt60S: number): Float32Array {
  const tau = rt60S / Math.log(1000);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = samples[i]! * Math.exp(-i / (tau * sampleRate));
  }
  return out;
}

/**
 * Dry close-mic: tone bursts with hard silence (Wolfe-like occupancy).
 * Amplitude 0.15 ≈ −16.5 dBFS speech level.
 */
function drySpeech(seconds: number, amplitude = 0.15): Float32Array {
  const burst = 0.22;
  const gap = 0.18;
  const parts: Float32Array[] = [];
  let t = 0;
  let n = 0;
  while (t < seconds) {
    parts.push(sine(burst, 180 + (n % 5) * 40, amplitude));
    parts.push(silence(gap));
    t += burst + gap;
    n += 1;
  }
  return concat(...parts);
}

/**
 * Phone-in-a-room: same bursts, but each offset rings with a long tail.
 */
function wetSpeech(seconds: number, rt60S: number, amplitude = 0.15): Float32Array {
  const burst = 0.22;
  const tail = Math.min(1.8, Math.max(0.8, rt60S));
  const parts: Float32Array[] = [];
  let t = 0;
  let n = 0;
  while (t < seconds) {
    const spoken = sine(burst, 180 + (n % 5) * 40, amplitude);
    const ring = applyDecay(
      sine(tail, 180 + (n % 5) * 40, amplitude * 0.85),
      SAMPLE_RATE,
      rt60S
    );
    parts.push(spoken, ring);
    t += burst + tail;
    n += 1;
  }
  return concat(...parts);
}

function floatToInt16(samples: Float32Array): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]!));
    buf.writeInt16LE(Math.round(x * 32767), i * 2);
  }
  return buf;
}

describe("measureCloneSamplePcm", () => {
  it("reports duration, speech occupancy, and a usable level for dry bursts", () => {
    const samples = drySpeech(14);
    const metrics = measureCloneSamplePcm(samples, SAMPLE_RATE);
    expect(metrics.duration_s).toBeGreaterThanOrEqual(13.5);
    expect(metrics.duration_s).toBeLessThan(15);
    expect(metrics.speech_frac).toBeGreaterThan(0.25);
    expect(metrics.speech_level_db).toBeGreaterThan(-45);
    expect(metrics.speech_level_db).toBeLessThan(-8);
    expect(metrics.clip_frac).toBeLessThanOrEqual(0.001);
  });

  it("flags heavy clipping", () => {
    const samples = drySpeech(13, 1.2);
    const metrics = measureCloneSamplePcm(samples, SAMPLE_RATE);
    expect(metrics.clip_frac).toBeGreaterThan(0.001);
  });

  it("flags a quiet mostly-silent take as low speech occupancy", () => {
    const samples = concat(sine(0.4, 200, 0.02), silence(13.6));
    const metrics = measureCloneSamplePcm(samples, SAMPLE_RATE);
    expect(metrics.speech_frac).toBeLessThan(0.25);
  });

  it("estimates high RT60 on synthetic phone-like decay (must fail)", () => {
    const samples = wetSpeech(16, 2.4);
    const metrics = measureCloneSamplePcm(samples, SAMPLE_RATE);
    expect(metrics.rt60_est_s == null || metrics.rt60_est_s > 0.95).toBe(true);
    if (metrics.rt60_est_s == null) {
      expect(metrics.reverb_proxy).toBeGreaterThan(0.4);
    }
    expect(evaluateCloneSampleQuality(metrics).verdict).toBe("fail");
    expect(
      evaluateCloneSampleQuality(metrics).fails.some(
        (f) => f.code === "too_reverberant" || f.code === "echo_in_speech"
      )
    ).toBe(true);
  });

  it("estimates mid RT60 on 'cleaned' wet speech (still fail)", () => {
    const samples = wetSpeech(16, 1.2);
    const metrics = measureCloneSamplePcm(samples, SAMPLE_RATE);
    const report = evaluateCloneSampleQuality(metrics);
    expect(report.verdict).toBe("fail");
    expect(
      report.fails.some((f) => f.code === "too_reverberant" || f.code === "echo_in_speech")
    ).toBe(true);
  });

  it("estimates low RT60 on dry bursts (Wolfe-like pass)", () => {
    const samples = drySpeech(16);
    const metrics = measureCloneSamplePcm(samples, SAMPLE_RATE);
    expect(metrics.rt60_est_s == null || metrics.rt60_est_s <= 0.75).toBe(true);
    expect(evaluateCloneSampleQuality(metrics).verdict).toBe("pass");
  });
});

describe("analyzeCloneSampleBuffer", () => {
  it("returns a fail report for a wet WAV and null for non-WAV", () => {
    const wav = pcmToWav(floatToInt16(wetSpeech(16, 2.4)), {
      sampleRate: SAMPLE_RATE,
      numChannels: 1,
      bitDepth: 16,
    });
    const report = analyzeCloneSampleBuffer(wav);
    expect(report).not.toBeNull();
    expect(report!.verdict).toBe("fail");

    const mp3ish = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00]);
    expect(analyzeCloneSampleBuffer(mp3ish)).toBeNull();
  });

  it("returns a pass report for a dry WAV", () => {
    const wav = pcmToWav(floatToInt16(drySpeech(16)), {
      sampleRate: SAMPLE_RATE,
      numChannels: 1,
      bitDepth: 16,
    });
    const report = analyzeCloneSampleBuffer(wav);
    expect(report).not.toBeNull();
    expect(report!.verdict).toBe("pass");
  });
});
