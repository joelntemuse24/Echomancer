import { afterEach, describe, expect, it } from "vitest";
import {
  EDGE_GOOGLE_SECTION_CONCURRENCY_DEFAULT,
  edgeGoogleSectionConcurrency,
  isEdgeOrGoogleProvider,
} from "@/lib/tts/section-concurrency";

describe("edgeGoogleSectionConcurrency", () => {
  afterEach(() => {
    delete process.env.TTS_EDGE_GOOGLE_SECTION_CONCURRENCY;
  });

  it("defaults to 6 and treats Edge and Google as the fast path", () => {
    expect(EDGE_GOOGLE_SECTION_CONCURRENCY_DEFAULT).toBe(6);
    expect(edgeGoogleSectionConcurrency()).toBe(6);
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
    expect(edgeGoogleSectionConcurrency()).toBe(6);
  });
});
