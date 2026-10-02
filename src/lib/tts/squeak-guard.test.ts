import { describe, expect, it } from "vitest";
import {
  detectSqueaks,
  estimatePitchProfile,
  repairSqueaks,
  squeakMinHz,
} from "./squeak-guard";

const SR = 44_100;

/** Deep voiced "speech": 85 Hz harmonics with a slow syllable envelope. */
function voice(seconds: number, f0 = 85): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 3 * t);
    let s = 0;
    for (let h = 1; h <= 30; h++) s += Math.sin(2 * Math.PI * f0 * h * t) / h;
    out[i] = 0.2 * env * s;
  }
  return out;
}

function addTone(pcm: Float32Array, startSec: number, durSec: number, freq: number, amp: number) {
  const a = Math.round(startSec * SR);
  const n = Math.round(durSec * SR);
  for (let i = 0; i < n; i++) {
    const w = Math.sin((Math.PI * i) / n);
    pcm[a + i] = pcm[a + i]! + amp * w * Math.sin((2 * Math.PI * freq * i) / SR);
  }
}

/** Voice, a silent tail, voice again. */
function phraseWithTail(): Float32Array {
  const pcm = new Float32Array(Math.round(4 * SR));
  pcm.set(voice(1.5), 0);
  pcm.set(voice(1.5), Math.round(2.5 * SR));
  return pcm;
}

const MIN_HZ = squeakMinHz({ medianHz: 85, p99Hz: 105 });

describe("squeak guard", () => {
  it("derives the threshold from the reference range", () => {
    expect(MIN_HZ).toBeCloseTo(255, 0);
    // An animated speaker's own high range raises the bar.
    expect(squeakMinHz({ medianHz: 150, p99Hz: 420 })).toBe(630);
  });

  it("estimates the pitch of a voice", () => {
    const profile = estimatePitchProfile(voice(3, 120), SR)!;
    expect(profile.medianHz).toBeGreaterThan(110);
    expect(profile.medianHz).toBeLessThan(130);
  });

  it("finds a phrase-final pure tone far above the speaker's pitch", () => {
    const pcm = phraseWithTail();
    addTone(pcm, 1.6, 0.2, 410, 0.05);
    const spans = detectSqueaks(pcm, SR, MIN_HZ);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.startSec).toBeGreaterThan(1.5);
    expect(spans[0]!.endSec).toBeLessThan(1.9);
    expect(spans[0]!.freqHz).toBeGreaterThan(390);
    expect(spans[0]!.freqHz).toBeLessThan(430);
  });

  it("leaves clean speech and in-range tones alone", () => {
    expect(detectSqueaks(phraseWithTail(), SR, MIN_HZ)).toHaveLength(0);
    const pcm = phraseWithTail();
    addTone(pcm, 1.6, 0.2, 200, 0.05);
    expect(detectSqueaks(pcm, SR, MIN_HZ)).toHaveLength(0);
  });

  it("ignores a long steady tone (not a squeak)", () => {
    const pcm = new Float32Array(Math.round(4 * SR));
    pcm.set(voice(1), 0);
    addTone(pcm, 1.2, 1.5, 410, 0.05);
    expect(detectSqueaks(pcm, SR, MIN_HZ)).toHaveLength(0);
  });

  it("notches the squeak out and touches nothing else", () => {
    const pcm = phraseWithTail();
    addTone(pcm, 1.6, 0.2, 410, 0.05);
    const spans = detectSqueaks(pcm, SR, MIN_HZ);
    const fixed = repairSqueaks(pcm, SR, spans);
    expect(detectSqueaks(fixed, SR, MIN_HZ)).toHaveLength(0);
    const from = Math.floor((spans[0]!.startSec - 0.02) * SR);
    const to = Math.ceil((spans[0]!.endSec + 0.02) * SR);
    for (let i = 0; i < pcm.length; i += 97) {
      if (i < from || i >= to) expect(fixed[i]).toBe(pcm[i]);
    }
    let before = 0;
    let after = 0;
    for (let i = from; i < to; i++) {
      before += pcm[i]! * pcm[i]!;
      after += fixed[i]! * fixed[i]!;
    }
    expect(10 * Math.log10(after / before)).toBeLessThan(-10);
  });
});
