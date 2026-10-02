import { describe, expect, it, vi } from "vitest";
import {
  guardSectionSqueaks,
  resolveSqueakGuard,
  squeakDetectorKind,
  squeakWholeSectionRetake,
} from "./section-squeak-guard";

describe("section squeak guard", () => {
  it("is off for stock voices and off the worker", async () => {
    expect(
      await resolveSqueakGuard({ userId: "u", catalogVoiceId: "fish-narrator", providerId: "fish" })
    ).toBeNull();
    // Vitest is not a mastering host, so even a clone gets no guard here.
    expect(
      await resolveSqueakGuard({ userId: "u", catalogVoiceId: "clone:abc", providerId: "fish" })
    ).toBeNull();
  });

  it("returns the original take untouched when audio cannot be decoded", async () => {
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
    expect(out.durationHintSeconds).toBe(3);
    expect(regenerate).not.toHaveBeenCalled();
  });

  it("repairs in place and does not re-record a section unless asked", () => {
    expect(squeakWholeSectionRetake({})).toBe(false);
    expect(squeakWholeSectionRetake({ TTS_SQUEAK_REGENERATE: "1" })).toBe(true);
    expect(squeakDetectorKind({})).toBe("spectral");
    expect(squeakDetectorKind({ TTS_SQUEAK_DETECTOR: "pitch" })).toBe("pitch");
  });
});
