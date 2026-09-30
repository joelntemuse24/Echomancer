import { afterEach, describe, expect, it } from "vitest";
import {
  EDGE_GOOGLE_SECTION_CONCURRENCY_DEFAULT,
  bindEdgeGoogleGate,
  createInFlightGate,
  edgeGoogleInFlightLimit,
  edgeGoogleSectionConcurrency,
  isEdgeOrGoogleProvider,
  isUpstreamThrottle,
  noteEdgeGoogleThrottle,
  resetEdgeGoogleThrottle,
} from "@/lib/tts/section-concurrency";

describe("edgeGoogleSectionConcurrency", () => {
  afterEach(() => {
    delete process.env.TTS_EDGE_GOOGLE_SECTION_CONCURRENCY;
    resetEdgeGoogleThrottle();
  });

  it("defaults to 8 and treats Edge and Google as the fast path", () => {
    expect(EDGE_GOOGLE_SECTION_CONCURRENCY_DEFAULT).toBe(8);
    expect(edgeGoogleSectionConcurrency()).toBe(8);
    expect(isEdgeOrGoogleProvider("edge")).toBe(true);
    expect(isEdgeOrGoogleProvider("google")).toBe(true);
    expect(isEdgeOrGoogleProvider("fish")).toBe(false);
    expect(isEdgeOrGoogleProvider("openrouter")).toBe(false);
  });

  it("clamps the worker pin to 1–8", () => {
    process.env.TTS_EDGE_GOOGLE_SECTION_CONCURRENCY = "8";
    expect(edgeGoogleSectionConcurrency()).toBe(8);
    process.env.TTS_EDGE_GOOGLE_SECTION_CONCURRENCY = "99";
    expect(edgeGoogleSectionConcurrency()).toBe(8);
    process.env.TTS_EDGE_GOOGLE_SECTION_CONCURRENCY = "0";
    expect(edgeGoogleSectionConcurrency()).toBe(8);
  });

  it("halves Edge/Google in flight after a 429 or 503", async () => {
    expect(isUpstreamThrottle("Unexpected server response: 429")).toBe(true);
    expect(isUpstreamThrottle("Google TTS 503: unavailable")).toBe(true);
    expect(isUpstreamThrottle("Google TTS 500: boom")).toBe(false);
    const gate = createInFlightGate(8);
    bindEdgeGoogleGate(gate);
    let running = 0;
    let maxRunning = 0;
    const hold: Array<() => void> = [];
    const workers = Array.from({ length: 8 }, async () => {
      await gate.acquire();
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise<void>((resolve) => hold.push(resolve));
      running -= 1;
      gate.release();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(maxRunning).toBe(8);
    expect(noteEdgeGoogleThrottle()).toBe(4);
    expect(edgeGoogleInFlightLimit()).toBe(4);
    for (const release of hold) release();
    await Promise.all(workers);
    let next = 0;
    const after = Array.from({ length: 6 }, async () => {
      await gate.acquire();
      next += 1;
      const seen = next;
      await new Promise((resolve) => setTimeout(resolve, 10));
      next -= 1;
      gate.release();
      return seen;
    });
    const peaks = await Promise.all(after);
    expect(Math.max(...peaks)).toBeLessThanOrEqual(4);
  });
});
