import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SLIM_STOCK_VOICE_IDS } from "@/lib/tts/standard-voice";
import { stockPreviewUrl } from "@/lib/tts/stock-preview";
import {
  isListedSowellVoice,
  isListedWalterVoice,
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
    { id: "drew", provider: "drew" as const, tags: ["stock"] },
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
    // The retired Andrew row is never in the pile even though it is present.
    expect(voicesForPath(voices, "standard").map((v) => v.id)).not.toContain(
      "standard"
    );
  });

  it("drops a Kokoro id that arrived on the wrong provider", () => {
    const wrongDrew = { id: "drew", provider: "edge" as const, tags: [] };
    const wrongGeorge = { id: "george", provider: "edge" as const, tags: [] };
    // A lone wrong-provider row is the only source for that id here, so the
    // card must be absent rather than served by something that cannot speak it.
    expect(
      voicesForPath([wrongDrew, wrongGeorge], "standard").map((v) => v.id)
    ).toEqual([]);
    // The right-provider rows still list, wherever the stray rows sit: a row
    // with a duplicated id cannot mask the card the server actually sent.
    expect(
      voicesForPath([...voices, wrongDrew, wrongGeorge], "standard").map((v) => v.id)
    ).toEqual([...SLIM_STOCK_VOICE_IDS]);
    expect(
      voicesForPath([wrongDrew, wrongGeorge, ...voices], "standard").map((v) => v.id)
    ).toEqual([...SLIM_STOCK_VOICE_IDS]);
  });

  it("adds a Walter card after the five when the server listed that provider", () => {
    const walter = {
      id: "sowell",
      provider: "sowell" as const,
      tags: ["sowell"],
      // The listed name is Walter; the internal id is unchanged.
      displayName: "Walter",
    };
    const listed = voicesForPath([...voices, walter], "standard");
    expect(listed.map((voice) => voice.id)).toEqual([
      ...SLIM_STOCK_VOICE_IDS,
      "sowell",
    ]);
    expect(listed.at(-1)?.displayName).toBe("Walter");
    expect(stockCardAudition(walter)).toBe("static");
    // The committed file keeps the internal id, so only the label moved.
    expect(stockPreviewUrl("sowell")).toBe("/voice-previews/sowell.mp3");
    expect(existsSync(path.join(process.cwd(), "public/voice-previews/sowell.mp3"))).toBe(
      true
    );
    expect(stockPreviewUrl("george")).toBe("/voice-previews/george.mp3");
    expect(existsSync(path.join(process.cwd(), "public/voice-previews/george.mp3"))).toBe(
      true
    );
    expect(isPersistableStandardVoiceId("sowell")).toBe(true);
    expect(isPersistableStandardVoiceId("drew")).toBe(true);
    expect(isListedWalterVoice(walter)).toBe(true);
    expect(isListedSowellVoice(walter)).toBe(true);
    const probe = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        path.join(process.cwd(), "public/voice-previews/sowell.mp3"),
      ],
      { encoding: "utf8" }
    );
    expect(probe.status, probe.stderr).toBe(0);
    const duration = Number(probe.stdout.trim());
    expect(duration).toBeGreaterThan(1);
    expect(duration).toBeLessThan(15);
  });

  it("hides Walter when the server omitted it and ignores another provider on that id", () => {
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
