import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SLIM_STOCK_VOICE_IDS } from "@/lib/tts/standard-voice";
import { stockPreviewUrl } from "@/lib/tts/stock-preview";
import {
  isListedSowellVoice,
  isPersistableStandardVoiceId,
  isUserCloneVoice,
  parseVoicePath,
  stockCardAudition,
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
    { id: "ryan", provider: "edge" as const, tags: [] },
    { id: "randolph", provider: "google" as const, tags: [] },
    { id: "standard", provider: "edge" as const, tags: [] },
    { id: "echomancer-andrew", provider: "paradee" as const, tags: [] },
    { id: "libby", provider: "edge" as const, tags: ["stock"] },
    { id: "clara", provider: "fish" as const, tags: ["stock"] },
    { id: "ava", provider: "edge" as const, tags: [] },
    { id: "george", provider: "george" as const, tags: ["stock"] },
    { id: "gemini-kore", provider: "gemini" as const, tags: [] },
  ];

  it("standard path is slim stock only, in picker order", () => {
    expect(voicesForPath(voices, "standard").map((v) => v.id)).toEqual([
      ...SLIM_STOCK_VOICE_IDS,
    ]);
  });

  it("adds a Sowell card after the five when the server listed that provider", () => {
    const sowell = {
      id: "sowell",
      provider: "sowell" as const,
      tags: ["sowell"],
      displayName: "Sowell",
    };
    const listed = voicesForPath([...voices, sowell], "standard");
    expect(listed.map((voice) => voice.id)).toEqual([
      ...SLIM_STOCK_VOICE_IDS,
      "sowell",
    ]);
    expect(listed.at(-1)?.displayName).toBe("Sowell");
    expect(stockCardAudition(sowell)).toBe("select-only");
    expect(stockPreviewUrl("sowell")).toBeNull();
    expect(existsSync(path.join(process.cwd(), "public/voice-previews/sowell.mp3"))).toBe(
      false
    );
    expect(stockPreviewUrl("george")).toBe("/voice-previews/george.mp3");
    expect(existsSync(path.join(process.cwd(), "public/voice-previews/george.mp3"))).toBe(
      true
    );
    expect(isPersistableStandardVoiceId("sowell")).toBe(true);
    expect(isListedSowellVoice(sowell)).toBe(true);
  });

  it("hides Sowell when the server omitted it and ignores another provider on that id", () => {
    expect(voicesForPath(voices, "standard").map((voice) => voice.id)).toEqual([
      ...SLIM_STOCK_VOICE_IDS,
    ]);
    const wrong = { id: "sowell", provider: "edge" as const, tags: [] };
    expect(voicesForPath([...voices, wrong], "standard").map((voice) => voice.id)).toEqual(
      [...SLIM_STOCK_VOICE_IDS]
    );
    expect(stockCardAudition(wrong)).toBe("play");
    expect(voicesForPath([...voices, { id: "sowell", provider: "sowell", tags: [] }], "clone").map(
      (voice) => voice.id
    )).toEqual(["clone:1"]);
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
