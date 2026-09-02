import { describe, expect, it } from "vitest";
import { fakeMp3 } from "@/test/harness";
import {
  readSectionCache,
  sectionCacheKey,
  writeSectionCache,
} from "@/lib/tts/section-cache";

describe("sectionCacheKey", () => {
  it("changes when text, voice, model, or latency changes", () => {
    const base = {
      text: "Hello",
      voiceId: "voice-1",
      model: "s2.1-pro-free",
      latency: "balanced",
    };
    const a = sectionCacheKey(base);
    expect(a).toHaveLength(64);
    expect(sectionCacheKey({ ...base, text: "Hello." })).not.toBe(a);
    expect(sectionCacheKey({ ...base, voiceId: "voice-2" })).not.toBe(a);
    expect(sectionCacheKey({ ...base, latency: "normal" })).not.toBe(a);
  });
});

describe("section cache storage", () => {
  it("round-trips bytes for a retry of the same section", async () => {
    const key = sectionCacheKey({
      text: "Chapter one.",
      voiceId: "narrator",
      model: "s2.1-pro-free",
      latency: "balanced",
    });
    const audio = fakeMp3(1024, 9);
    await writeSectionCache(key, "mp3", audio, "audio/mpeg");
    const hit = await readSectionCache(key, "mp3");
    expect(hit?.equals(audio)).toBe(true);
  });
});
