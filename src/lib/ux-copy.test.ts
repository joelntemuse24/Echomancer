import { describe, expect, it } from "vitest";
import { voiceEngineStarting } from "./ux-copy";

describe("voiceEngineStarting", () => {
  it("is the clone book before the first section", () => {
    expect(
      voiceEngineStarting({
        catalog_voice_id: "clone:abc",
        status: "processing",
        progress: 0,
      } as never)
    ).toBe(true);
  });

  it("is not extract, a stock voice, or a book that already has audio", () => {
    expect(
      voiceEngineStarting({
        catalog_voice_id: "clone:abc",
        status: "waiting",
        waiting_for_text: true,
      })
    ).toBe(false);
    expect(
      voiceEngineStarting({
        catalog_voice_id: "standard",
        status: "processing",
      })
    ).toBe(false);
    expect(
      voiceEngineStarting({
        catalog_voice_id: "clone:abc",
        status: "processing",
        first_section_at: 1,
      })
    ).toBe(false);
    expect(
      voiceEngineStarting({
        catalog_voice_id: "clone:abc",
        status: "queued",
        segments: [{ path: "audiobooks/j/sections/0000.mp3", status: "ready" }],
      })
    ).toBe(false);
  });
});
