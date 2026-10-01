import { describe, expect, it } from "vitest";
import { masterClipPcm } from "./clip-master";

const RATE = 48_000;

function tone(seconds: number, amplitude: number): Float32Array {
  const n = Math.floor(seconds * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / RATE);
  return out;
}

describe("masterClipPcm", () => {
  it("rejects silence and clips under 8 seconds", () => {
    expect(masterClipPcm(new Float32Array(RATE * 12)).ok).toBe(false);
    expect(masterClipPcm(tone(5, 0.2)).ok).toBe(false);
  });

  it("writes a 16-bit wav and caps a long take at 40 seconds", () => {
    const lead = new Float32Array(Math.floor(RATE * 1.5));
    const body = tone(50, 0.2);
    const input = new Float32Array(lead.length + body.length);
    input.set(body, lead.length);
    const result = masterClipPcm(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    const dataBytes = result.wav.length - 44;
    expect(dataBytes).toBeLessThanOrEqual(40 * RATE * 2);
    expect(dataBytes).toBeGreaterThan(8 * RATE * 2);
  });
});
