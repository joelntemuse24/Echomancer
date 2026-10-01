import { describe, expect, it } from "vitest";
import { integratedLufs, prepareClonePcm } from "./clone-sample-prepare";

const RATE = 48_000;

function tone(seconds: number, freq: number, amplitude: number): Float32Array {
  const n = Math.floor(seconds * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / RATE);
  }
  return out;
}

describe("prepareClonePcm", () => {
  it("drops leading silence and sets the level with gain only", () => {
    const lead = new Float32Array(Math.floor(2.1 * RATE));
    const body = tone(3, 1000, 0.02);
    const input = new Float32Array(lead.length + body.length);
    input.set(body, lead.length);
    const prepared = prepareClonePcm(input, RATE);
    expect(prepared.samples.length).toBeLessThan(input.length - RATE);
    expect(prepared.samples.length).toBeGreaterThan(2 * RATE);
    const lufs = integratedLufs(prepared.samples, RATE);
    expect(lufs).not.toBeNull();
    expect(Math.abs(lufs! - -20)).toBeLessThan(1.5);
    let peak = 0;
    for (let i = 0; i < prepared.samples.length; i++) {
      peak = Math.max(peak, Math.abs(prepared.samples[i]!));
    }
    expect(peak).toBeLessThanOrEqual(0.99);
  });

  it("levels 48 seconds of audio without a long wait", () => {
    const n = 48 * RATE;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      samples[i] = 0.05 * Math.sin((2 * Math.PI * 180 * i) / RATE);
    }
    const started = Date.now();
    const prepared = prepareClonePcm(samples, RATE);
    const ms = Date.now() - started;
    console.info(`[clone] prepare 48s pcm ms=${ms}`);
    expect(ms).toBeLessThan(500);
    expect(prepared.samples.length).toBe(n);
    const lufs = integratedLufs(prepared.samples, RATE);
    expect(lufs).not.toBeNull();
    expect(Math.abs(lufs! - -20)).toBeLessThan(1.5);
  });
});
