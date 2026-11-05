import { describe, expect, it } from "vitest";
import {
  QWEN_PAUSE_MS,
  QWEN_SAMPLE_RATE,
  degatePcm,
  frameLevelsDb,
  joinQwenChunks,
  matchGainsDb,
  parseQwenPost,
  speechLevelDb,
  toFloat,
  toPcm16,
} from "@/lib/tts/qwen-join";

const SR = QWEN_SAMPLE_RATE;

/** Voiced-ish tone bursts at `amp`, each `burstMs` long with `gapMs` of digital zero between. */
function gatedSpeech(amp: number, bursts = 4, burstMs = 300, gapMs = 120): Float32Array {
  const burst = Math.round((SR * burstMs) / 1000);
  const gap = Math.round((SR * gapMs) / 1000);
  const x = new Float32Array(bursts * (burst + gap));
  for (let b = 0; b < bursts; b++) {
    const at = b * (burst + gap);
    for (let i = 0; i < burst; i++) {
      x[at + i] = amp * (Math.sin((2 * Math.PI * 140 * i) / SR) + 0.4 * Math.sin((2 * Math.PI * 1100 * i) / SR));
    }
  }
  return x;
}

const identity = async (b: Buffer) => b;

describe("parseQwenPost", () => {
  it("defaults to both repairs and can turn them off", () => {
    expect(parseQwenPost(undefined)).toEqual({ deline: true, degate: true });
    expect(parseQwenPost("off")).toEqual({ deline: false, degate: false });
    expect(parseQwenPost("deline")).toEqual({ deline: true, degate: false });
  });
});

describe("matchGainsDb", () => {
  it("brings each chunk to the median and clamps at ±6 dB", () => {
    expect(matchGainsDb([-20, -22, -30, null])).toEqual([-2, 0, 6, 0]);
  });
});

describe("degatePcm", () => {
  it("fills digital silence with a quiet bed and leaves speech alone", () => {
    const x = gatedSpeech(0.3);
    const before = x.slice();
    const stats = degatePcm(x);
    expect(stats.deadRuns).toBe(4);
    expect(stats.deadMs).toBeGreaterThan(300);
    const e = frameLevelsDb(x, SR, 5);
    const pk = [...e].sort((a, b) => a - b)[Math.floor(e.length * 0.95)]!;
    // No frame sits at digital zero any more.
    expect(Math.min(...e)).toBeGreaterThan(pk - 75);
    // Middle of a burst is untouched.
    const mid = Math.round(SR * 0.15);
    expect(x[mid]).toBeCloseTo(before[mid]!, 6);
  });

  it("gives a chopped word a decay instead of a 5 ms drop", () => {
    const x = gatedSpeech(0.3, 2);
    degatePcm(x);
    const e = frameLevelsDb(x, SR, 5);
    const end = Math.round(300 / 5); // first frame after the first burst
    // Within 10 ms of the cut the level has fallen less than 30 dB.
    expect(e[end - 1]! - e[end + 1]!).toBeLessThan(30);
  });

  it("is deterministic for a given seed", () => {
    const a = gatedSpeech(0.3);
    const b = gatedSpeech(0.3);
    degatePcm(a, { seed: 3 });
    degatePcm(b, { seed: 3 });
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
  });
});

describe("joinQwenChunks", () => {
  it("level-matches chunks and inserts boundary pauses", async () => {
    const loud = toPcm16(gatedSpeech(0.4, 1, 500, 0));
    const quiet = toPcm16(gatedSpeech(0.1, 1, 500, 0));
    const out = await joinQwenChunks(
      [
        { audio: loud, boundary: "start" },
        { audio: quiet, boundary: "paragraph" },
        { audio: loud, boundary: "sentence" },
      ],
      { post: { deline: false, degate: false }, decode: identity, encode: false }
    );
    expect(out.gainsDb[1]).toBe(6);
    expect(out.gainsDb[0]).toBe(0);
    const expected = 1.5 + (QWEN_PAUSE_MS.paragraph + QWEN_PAUSE_MS.sentence) / 1000;
    expect(out.durationSeconds).toBeGreaterThan(expected - 0.1);
    expect(out.durationSeconds).toBeLessThan(expected + 0.1);
    const secondChunk = out.pcm.subarray(
      Math.round((0.5 + QWEN_PAUSE_MS.paragraph / 1000) * SR) * 2,
      Math.round((1.0 + QWEN_PAUSE_MS.paragraph / 1000) * SR) * 2
    );
    const firstChunk = out.pcm.subarray(0, Math.round(0.5 * SR) * 2);
    expect(Math.abs(speechLevelDb(secondChunk)! - speechLevelDb(firstChunk)!)).toBeLessThan(6.5);
    expect(out.degate).toBeNull();
  });

  it("degates the join when asked", async () => {
    const piece = toPcm16(gatedSpeech(0.3, 2));
    const out = await joinQwenChunks(
      [
        { audio: piece, boundary: "start" },
        { audio: piece, boundary: "sentence" },
      ],
      { post: { deline: false, degate: true }, decode: identity, encode: false }
    );
    expect(out.degate?.deadRuns).toBeGreaterThanOrEqual(3);
    const e = frameLevelsDb(toFloat(out.pcm), SR, 5);
    const pk = [...e].sort((a, b) => a - b)[Math.floor(e.length * 0.95)]!;
    expect(Math.min(...e)).toBeGreaterThan(pk - 75);
  });
});
