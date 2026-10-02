import { describe, expect, it } from "vitest";
import { REF_RATE, highBandDb, powerSpectrum, speechMask, speechSeconds } from "@/lib/tts/reference-quality/dsp";

function naivePower(x: Float64Array): Float64Array {
  const n = x.length;
  const out = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) {
    let re = 0;
    let im = 0;
    for (let t = 0; t < n; t++) {
      re += x[t]! * Math.cos((2 * Math.PI * k * t) / n);
      im -= x[t]! * Math.sin((2 * Math.PI * k * t) / n);
    }
    out[k] = re * re + im * im;
  }
  return out;
}

function noise(seconds: number, seed = 1): Float32Array {
  let s = seed;
  const out = new Float32Array(Math.round(seconds * REF_RATE));
  for (let i = 0; i < out.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    // Bursts like syllables: 300 ms of sound, 200 ms of near silence.
    const on = (i / REF_RATE) % 0.5 < 0.3;
    out[i] = (s / 0x7fffffff - 0.5) * (on ? 0.5 : 0.001);
  }
  return out;
}

describe("reference-quality dsp", () => {
  it("matches a direct DFT for 400 and 512 point frames", () => {
    for (const n of [400, 512]) {
      const x = new Float64Array(n);
      for (let i = 0; i < n; i++) x[i] = Math.sin(i * 0.37) + 0.3 * Math.cos(i * 1.91) + (i % 7) / 10;
      const fast = powerSpectrum(x.slice());
      const slow = naivePower(x);
      for (let k = 0; k < slow.length; k++) {
        expect(Math.abs(fast[k]! - slow[k]!)).toBeLessThan(1e-6 * Math.max(1, slow[k]!));
      }
    }
  });

  it("reads wide-band audio near 0 dB and a 4 kHz low-passed copy far below -45 dB", () => {
    const wide = noise(3);
    const mask = speechMask(wide);
    expect(speechSeconds(mask)).toBeGreaterThan(1.5);
    expect(highBandDb(wide, mask)).toBeGreaterThan(-10);

    // Crude 3.4 kHz low-pass: a long windowed-sinc FIR.
    const taps = 255;
    const fc = 3400 / REF_RATE;
    const h = new Float64Array(taps);
    for (let i = 0; i < taps; i++) {
      const m = i - (taps - 1) / 2;
      const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
      h[i] = sinc * (0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1)));
    }
    const narrow = new Float32Array(wide.length);
    for (let i = taps; i < wide.length; i++) {
      let acc = 0;
      for (let j = 0; j < taps; j++) acc += h[j]! * wide[i - j]!;
      narrow[i] = acc;
    }
    expect(highBandDb(narrow, speechMask(narrow))).toBeLessThan(-45);
  });
});
