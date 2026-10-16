import { describe, expect, it } from "vitest";
import {
  measureWindowSeconds,
  parseStreamConn,
  planStreamWindows,
  streamSpeakableText,
} from "@/lib/tts/stream-timeline";

describe("planStreamWindows", () => {
  it("locates trimmed windows in the slice at an absolute offset", () => {
    const slice = "First one.  Second one.\n\nThird.";
    const windows = ["First one.", "Second one.", "Third."];
    const plan = planStreamWindows(slice, windows, 100);
    expect(plan.map((w) => slice.slice(w.start - 100, w.end - 100))).toEqual(windows);
    expect(plan.every((w) => w.seconds === null)).toBe(true);
  });

  it("finds a repeated window after the previous one, not at the first copy", () => {
    const plan = planStreamWindows("Echo. Echo.", ["Echo.", "Echo."], 0);
    expect(plan.map((w) => w.start)).toEqual([0, 6]);
  });
});

describe("measureWindowSeconds", () => {
  it("measures raw PCM from its sample rate", () => {
    expect(measureWindowSeconds([new Uint8Array(48_000)], { pcm: true, sampleRate: 24_000 })).toBe(1);
  });
  it("returns null for empty or unparseable audio", () => {
    expect(measureWindowSeconds([], { pcm: false })).toBeNull();
    expect(measureWindowSeconds([new Uint8Array(64)], { pcm: false })).toBeNull();
  });
});

describe("parseStreamConn", () => {
  it("accepts url-safe ids and drops anything else", () => {
    expect(parseStreamConn("abc12345-_")).toBe("abc12345-_");
    for (const bad of [null, "", "short", "has space 123", "x".repeat(65)]) {
      expect(parseStreamConn(bad)).toBeNull();
    }
  });
});

describe("streamSpeakableText", () => {
  it("is trimmed so transcript offsets equal stream cursor offsets", () => {
    const text = streamSpeakableText("\n\n  Chapter One\n\nThe tide came in.\n\n", {});
    expect(text).toBe(text.trim());
    expect(text).toContain("The tide came in.");
  });
});
