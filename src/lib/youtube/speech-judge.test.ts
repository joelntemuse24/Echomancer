import { describe, expect, it } from "vitest";
import { YOUTUBE_COPY } from "./messages";
import { judgeSpeech } from "./speech-judge";

const RATE = 16_000;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function speechLike(seconds: number, noise = 0.004): Float32Array {
  const rand = mulberry32(7);
  const n = Math.floor(seconds * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
    const voice =
      Math.sin(2 * Math.PI * 180 * t) +
      0.45 * Math.sin(2 * Math.PI * 700 * t) +
      0.2 * Math.sin(2 * Math.PI * 2400 * t);
    out[i] = env * 0.22 * voice + (rand() * 2 - 1) * noise;
  }
  return out;
}

function whiteNoise(seconds: number): Float32Array {
  const rand = mulberry32(3);
  const n = Math.floor(seconds * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (rand() * 2 - 1) * 0.25;
  return out;
}

function twoVoices(seconds: number): Float32Array {
  const n = Math.floor(seconds * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 3.5 * t);
    out[i] =
      env *
      0.28 *
      (Math.sin(2 * Math.PI * 140 * t) + Math.sin(2 * Math.PI * 220 * t));
  }
  return out;
}

describe("judgeSpeech", () => {
  it("accepts a stretch of one modulated voice", () => {
    const verdict = judgeSpeech(speechLike(12), RATE);
    expect(verdict.ok).toBe(true);
    expect(verdict.speechSec).toBeGreaterThan(8);
    expect(verdict.separateVocals).toBe(false);
  });

  it("rejects a short burst of speech", () => {
    const clip = new Float32Array(Math.floor(12 * RATE));
    clip.set(speechLike(2), Math.floor(4 * RATE));
    const verdict = judgeSpeech(clip, RATE);
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("short_speech");
    expect(verdict.message).toBe(YOUTUBE_COPY.shortSpeech);
  });

  it("rejects noise that is not speech", () => {
    const verdict = judgeSpeech(whiteNoise(12), RATE);
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("music");
    expect(verdict.message).toBe(YOUTUBE_COPY.music);
  });

  it("rejects two pitches at once", () => {
    const verdict = judgeSpeech(twoVoices(12), RATE);
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("overlap");
    expect(verdict.message).toBe(YOUTUBE_COPY.overlap);
  });
});
