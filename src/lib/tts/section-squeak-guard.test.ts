import { describe, expect, it, vi } from "vitest";
import {
  guardSectionSqueaks,
  resolveSqueakGuard,
  squeakGuardEnabled,
  squeakWholeSectionRetake,
} from "./section-squeak-guard";

describe("section squeak guard", () => {
  it("stays off until TTS_SQUEAK_CHECK=1", () => {
    expect(squeakGuardEnabled({})).toBe(false);
    expect(squeakGuardEnabled({ TTS_SQUEAK_GUARD: "1" })).toBe(false);
    expect(squeakGuardEnabled({ TTS_SQUEAK_CHECK: "1" })).toBe(true);
    expect(squeakGuardEnabled({ TTS_SQUEAK_CHECK: "1", TTS_SQUEAK_GUARD: "0" })).toBe(false);
  });

  it("is off for stock voices even when the check is enabled", async () => {
    const previous = process.env.TTS_SQUEAK_CHECK;
    process.env.TTS_SQUEAK_CHECK = "1";
    try {
      expect(
        await resolveSqueakGuard({ userId: "u", catalogVoiceId: "fish-narrator", providerId: "fish" })
      ).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.TTS_SQUEAK_CHECK;
      else process.env.TTS_SQUEAK_CHECK = previous;
    }
  });

  it("returns the original take without decoding when the check is off", async () => {
    const audio = Buffer.from("not audio at all");
    const regenerate = vi.fn(async () => null);
    const out = await guardSectionSqueaks({
      jobId: "j",
      index: 0,
      take: { audio, contentType: "audio/mpeg", durationHintSeconds: 3 },
      ctx: { minHz: 255, profile: null },
      regenerate,
    });
    expect(out.audio).toBe(audio);
    expect(out.contentType).toBe("audio/mpeg");
    expect(out.repaired).toBe(0);
    expect(regenerate).not.toHaveBeenCalled();
  });

  it("returns the original take untouched when audio cannot be decoded", async () => {
    const previous = process.env.TTS_SQUEAK_CHECK;
    process.env.TTS_SQUEAK_CHECK = "1";
    const audio = Buffer.from("not audio at all");
    const regenerate = vi.fn(async () => null);
    try {
      const out = await guardSectionSqueaks({
        jobId: "j",
        index: 0,
        take: { audio, contentType: "audio/mpeg", durationHintSeconds: 3 },
        ctx: { minHz: 255, profile: null },
        regenerate,
      });
      expect(out.audio).toBe(audio);
      expect(out.contentType).toBe("audio/mpeg");
      expect(out.durationHintSeconds).toBe(3);
      expect(regenerate).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.TTS_SQUEAK_CHECK;
      else process.env.TTS_SQUEAK_CHECK = previous;
    }
  });

  it("does not re-record a section unless asked", () => {
    expect(squeakWholeSectionRetake({})).toBe(false);
    expect(squeakWholeSectionRetake({ TTS_SQUEAK_REGENERATE: "1" })).toBe(true);
  });
});
