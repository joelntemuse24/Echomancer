import { describe, expect, it } from "vitest";
import { SLIM_STOCK_VOICE_IDS } from "@/lib/tts/standard-voice";
import {
  isUserCloneVoice,
  parseVoicePath,
  voicesForPath,
  withVoicePathParam,
} from "@/lib/voice-path";

describe("parseVoicePath", () => {
  it("accepts standard and clone only", () => {
    expect(parseVoicePath("standard")).toBe("standard");
    expect(parseVoicePath("clone")).toBe("clone");
    expect(parseVoicePath("classic")).toBeNull();
    expect(parseVoicePath("Standard")).toBeNull();
    expect(parseVoicePath("")).toBeNull();
    expect(parseVoicePath(null)).toBeNull();
    expect(parseVoicePath(undefined)).toBeNull();
  });
});

describe("voicesForPath", () => {
  const voices = [
    { id: "clone:1", provider: "fish" as const, tags: ["cloned"] },
    { id: "randolph", provider: "google" as const, tags: [] },
    { id: "standard", provider: "edge" as const, tags: [] },
    { id: "clara", provider: "fish" as const, tags: ["stock"] },
    { id: "michelle", provider: "edge" as const, tags: [] },
    { id: "gemini-kore", provider: "gemini" as const, tags: [] },
  ];

  it("standard path is slim stock only, in picker order", () => {
    expect(voicesForPath(voices, "standard").map((v) => v.id)).toEqual([
      ...SLIM_STOCK_VOICE_IDS,
    ]);
  });

  it("clone path is user clones only — not Clara", () => {
    expect(voicesForPath(voices, "clone").map((v) => v.id)).toEqual(["clone:1"]);
  });

  it("treats Clara as stock, not a user clone", () => {
    expect(isUserCloneVoice({ id: "clara", provider: "fish", tags: ["stock"] })).toBe(
      false
    );
    expect(isUserCloneVoice({ id: "clone:1", provider: "fish", tags: ["cloned"] })).toBe(
      true
    );
  });
});

describe("withVoicePathParam", () => {
  it("sets and clears path without dropping intake params", () => {
    const base = new URLSearchParams("pdfPath=x&pdfName=Book&charCount=10");
    expect(withVoicePathParam(base, "standard").toString()).toBe(
      "pdfPath=x&pdfName=Book&charCount=10&path=standard"
    );
    expect(withVoicePathParam(withVoicePathParam(base, "clone"), null).toString()).toBe(
      "pdfPath=x&pdfName=Book&charCount=10"
    );
  });
});
