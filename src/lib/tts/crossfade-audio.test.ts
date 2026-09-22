import { describe, expect, it } from "vitest";
import { pcmToWav, stripWavHeader } from "./pcm-wav";
import {
  CROSSFADE_MS_DEFAULT,
  CROSSFADE_MS_MAX,
  CROSSFADE_MS_MIN,
  JOIN_SILENCE_KEEP_MS,
  MICRO_JOIN_FADE_MS,
  acrossfadeFilterComplex,
  clampCrossfadeMs,
  concatPcm16MonoWithCrossfade,
  crossfadePcm16Mono,
  resolveJoinFadeMs,
  trimPcm16EdgeSilence,
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
    // Quarter-sine equal power at the midpoint is cos(π/4) ≈ 0.707.
    expect(midSample).toBeGreaterThan(5400);
    expect(midSample).toBeLessThan(5900);
  });

  it("honors a sub-80ms fade when clamp is off", () => {
    const fadeSamples = Math.round((RATE * MICRO_JOIN_FADE_MS) / 1000);
    const left = constPcm(4000, RATE);
    const right = constPcm(4000, RATE);
    const out = crossfadePcm16Mono(left, right, RATE, MICRO_JOIN_FADE_MS, {
      clamp: false,
    });
    expect(out.length / BYTES_PER_SAMPLE).toBe(RATE + RATE - fadeSamples);
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
  it("builds a chained equal-power ffmpeg acrossfade graph", () => {
    expect(acrossfadeFilterComplex(2, 0.12)).toBe(
      "[0:a][1:a]acrossfade=d=0.12:c1=qsin:c2=qsin[out]"
    );
    expect(acrossfadeFilterComplex(3, 0.12)).toBe(
      "[0:a][1:a]acrossfade=d=0.12:c1=qsin:c2=qsin[a1];[a1][2:a]acrossfade=d=0.12:c1=qsin:c2=qsin[out]"
    );
  });
});

describe("resolveJoinFadeMs", () => {
  it("uses a short click-guard on mid-paragraph cuts and the full fade elsewhere", () => {
    expect(resolveJoinFadeMs("mid-paragraph", 120)).toEqual({
      ms: MICRO_JOIN_FADE_MS,
      clamp: false,
    });
    expect(resolveJoinFadeMs("paragraph", 120)).toEqual({ ms: 120, clamp: true });
    expect(resolveJoinFadeMs("chapter", 120)).toEqual({ ms: 120, clamp: true });
    expect(resolveJoinFadeMs("mid-paragraph", 0)).toEqual({ ms: 0, clamp: false });
  });
});

describe("trimPcm16EdgeSilence", () => {
  it("keeps a short pad and does not eat the spoken samples", () => {
    const keep = Math.round((RATE * JOIN_SILENCE_KEEP_MS) / 1000);
    const pad = Math.round((RATE * 200) / 1000);
    const body = constPcm(8000, RATE);
    const pcm = Buffer.concat([constPcm(0, pad), body, constPcm(0, pad)]);
    const trimmed = trimPcm16EdgeSilence(pcm, RATE);
    expect(trimmed.length / BYTES_PER_SAMPLE).toBe(keep + RATE + keep);
    expect(trimmed.readInt16LE(keep * BYTES_PER_SAMPLE)).toBe(8000);
  });

  it("leaves a fully silent buffer and a hot buffer unchanged", () => {
    const silent = constPcm(0, 2_000);
    const hot = constPcm(8000, RATE);
    expect(trimPcm16EdgeSilence(silent, RATE).equals(silent)).toBe(true);
    expect(trimPcm16EdgeSilence(hot, RATE).equals(hot)).toBe(true);
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
