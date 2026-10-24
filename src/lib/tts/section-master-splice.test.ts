import { describe, expect, it } from "vitest";
import { rateSplice } from "@/lib/tts/section-master";

const SAMPLE_RATE = 44_100;

/**
 * Loud, bounded random walk. Every sample steps by ±`step`, so the noise
 * has no step of its own larger than that, yet sits well above the join
 * floor in level.
 */
function loudNoise(samples: number, step = 1400): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  let value = 0;
  let seed = 0x5eed;
  for (let i = 0; i < samples; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const random = (seed >>> 8) / 0x1000000;
    const up = Math.abs(value) > 9000 ? value < 0 : random < 0.5;
    value += up ? step : -step;
    pcm.writeInt16LE(value, i * 2);
  }
  return pcm;
}

/** Shift every sample from `at` on, which leaves exactly one step of `jump` there. */
function insertStep(pcm: Buffer, at: number, jump: number): void {
  const delta = jump - (pcm.readInt16LE(at * 2) - pcm.readInt16LE((at - 1) * 2));
  for (let i = at; i < pcm.length / 2; i++) {
    pcm.writeInt16LE(pcm.readInt16LE(i * 2) + delta, i * 2);
  }
}

describe("rateSplice", () => {
  const samples = Math.round(0.5 * SAMPLE_RATE);
  const center = Math.round(0.25 * SAMPLE_RATE);

  it("rejects a 9000 step spliced into loud noise", () => {
    const pcm = loudNoise(samples);
    insertStep(pcm, center, 9000);
    const rated = rateSplice(pcm, center);
    expect(rated.jump).toBe(9000);
    // The wings' own steps cap the gate near 2100. Seven times their p99
    // would have been about 9800 and let this splice through.
    expect(rated.limit).toBeLessThan(9000);
    expect(rated.jump).toBeGreaterThanOrEqual(rated.limit);
  });

  it("passes the same noise without the step", () => {
    const rated = rateSplice(loudNoise(samples), center);
    expect(rated.jump).toBe(1400);
    expect(rated.jump).toBeLessThan(rated.limit);
  });
});
