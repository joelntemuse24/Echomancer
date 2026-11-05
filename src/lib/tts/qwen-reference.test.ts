import { describe, expect, it } from "vitest";
import { QWEN_SAMPLE_RATE } from "@/lib/tts/qwen-join";
import { pickReferenceWindow, shapeReference } from "@/lib/tts/qwen-reference";

const SR = QWEN_SAMPLE_RATE;

/** `pattern` of [seconds, speaking?] spans. */
function clip(pattern: [number, boolean][]): Float32Array {
  const total = pattern.reduce((s, [d]) => s + d, 0);
  const x = new Float32Array(Math.round(total * SR));
  let at = 0;
  for (const [d, on] of pattern) {
    const n = Math.round(d * SR);
    if (on) for (let i = 0; i < n; i++) x[at + i] = 0.3 * Math.sin((2 * Math.PI * 150 * (at + i)) / SR);
    at += n;
  }
  return x;
}

describe("pickReferenceWindow", () => {
  it("lands on the densest stretch of speech", () => {
    const x = clip([
      [1, true], [1.5, false], [1, true], [1.5, false], // sparse start
      [7, true], // dense middle
      [2, false], [1, true],
    ]);
    const w = pickReferenceWindow(x, 6);
    expect(w.startSeconds).toBeGreaterThanOrEqual(5);
    expect(w.endSeconds).toBeLessThanOrEqual(12);
    expect(w.speechFraction).toBeGreaterThan(0.95);
  });

  it("returns the whole clip when it is shorter than the window", () => {
    const w = pickReferenceWindow(clip([[3, true]]), 6);
    expect(w).toEqual({ startSeconds: 0, endSeconds: 3, speechFraction: 1 });
  });
});

describe("shapeReference", () => {
  it("trims silent edges, pads 120 ms, and peaks at 0.70", () => {
    const shaped = shapeReference(clip([[1, false], [2, true], [1, false]]));
    const seconds = shaped.length / SR;
    expect(seconds).toBeGreaterThan(2.2);
    expect(seconds).toBeLessThan(2.4);
    let peak = 0;
    for (const v of shaped) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeCloseTo(0.7, 2);
    expect(shaped[Math.round(0.1 * SR)]).toBe(0);
  });
});
