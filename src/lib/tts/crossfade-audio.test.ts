import { describe, expect, it } from "vitest";
import { pcmToWav, stripWavHeader } from "./pcm-wav";
import {
  CROSSFADE_MS_DEFAULT,
  CROSSFADE_MS_MAX,
  CROSSFADE_MS_MIN,
  acrossfadeFilterComplex,
  clampCrossfadeMs,
  concatPcm16MonoWithCrossfade,
  crossfadePcm16Mono,
} from "./crossfade-audio";

const RATE = 24_000;
const BYTES_PER_SAMPLE = 2;

function constPcm(sample: number, samples: number): Buffer {
  const buf = Buffer.alloc(samples * BYTES_PER_SAMPLE);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(sample, i * BYTES_PER_SAMPLE);
  }
  return buf;
}

describe("clampCrossfadeMs", () => {
  it("defaults to 120ms and stays inside 80–150", () => {
    expect(clampCrossfadeMs()).toBe(CROSSFADE_MS_DEFAULT);
    expect(clampCrossfadeMs(120)).toBe(120);
    expect(clampCrossfadeMs(80)).toBe(CROSSFADE_MS_MIN);
    expect(clampCrossfadeMs(150)).toBe(CROSSFADE_MS_MAX);
    expect(clampCrossfadeMs(10)).toBe(CROSSFADE_MS_MIN);
    expect(clampCrossfadeMs(400)).toBe(CROSSFADE_MS_MAX);
    expect(clampCrossfadeMs(0)).toBe(0);
  });
});

describe("crossfadePcm16Mono", () => {
  it("overlaps two constant tones for the requested window", () => {
    const fadeSamples = Math.round((RATE * 120) / 1000);
    const left = constPcm(8000, RATE);
    const right = constPcm(0, RATE);
    const out = crossfadePcm16Mono(left, right, RATE, 120);

    const expectedSamples = RATE + RATE - fadeSamples;
    expect(out.length / BYTES_PER_SAMPLE).toBe(expectedSamples);

    const mid = RATE - fadeSamples + Math.floor(fadeSamples / 2);
    const midSample = out.readInt16LE(mid * BYTES_PER_SAMPLE);
    expect(midSample).toBeGreaterThan(3000);
    expect(midSample).toBeLessThan(5000);
  });

  it("returns the other side when a buffer is empty", () => {
    const pcm = constPcm(100, 48);
    expect(crossfadePcm16Mono(Buffer.alloc(0), pcm, RATE, 120).equals(pcm)).toBe(
      true
    );
    expect(crossfadePcm16Mono(pcm, Buffer.alloc(0), RATE, 120).equals(pcm)).toBe(
      true
    );
  });
});

describe("concatPcm16MonoWithCrossfade", () => {
  it("is a no-op for a single part", () => {
    const pcm = constPcm(12, 100);
    expect(concatPcm16MonoWithCrossfade([pcm], RATE, 120).equals(pcm)).toBe(
      true
    );
  });

  it("joins three parts shorter than a hard concat", () => {
    const a = constPcm(1000, RATE);
    const b = constPcm(2000, RATE);
    const c = constPcm(3000, RATE);
    const hard = Buffer.concat([a, b, c]);
    const soft = concatPcm16MonoWithCrossfade([a, b, c], RATE, 120);
    expect(soft.length).toBeLessThan(hard.length);
  });
});

describe("acrossfadeFilterComplex", () => {
  it("builds a chained ffmpeg acrossfade graph", () => {
    expect(acrossfadeFilterComplex(2, 0.12)).toBe(
      "[0:a][1:a]acrossfade=d=0.12:c1=tri:c2=tri[out]"
    );
    expect(acrossfadeFilterComplex(3, 0.12)).toBe(
      "[0:a][1:a]acrossfade=d=0.12:c1=tri:c2=tri[a1];[a1][2:a]acrossfade=d=0.12:c1=tri:c2=tri[out]"
    );
  });
});

describe("WAV helper round-trip", () => {
  it("crossfades PCM extracted from WAV headers", () => {
    const left = pcmToWav(constPcm(8000, RATE), { sampleRate: RATE });
    const right = pcmToWav(constPcm(0, RATE), { sampleRate: RATE });
    const out = concatPcm16MonoWithCrossfade(
      [stripWavHeader(left), stripWavHeader(right)],
      RATE,
      120
    );
    expect(out.length).toBeLessThan(
      stripWavHeader(left).length + stripWavHeader(right).length
    );
  });
});
