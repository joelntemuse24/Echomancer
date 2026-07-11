import { describe, expect, it } from "vitest";
import {
  normalizeVoiceClips,
  parseStoredVoiceClips,
  primaryVoiceClip,
  serializeVoiceClips,
} from "./voice-clips";

describe("voice clip style bank", () => {
  it("converts legacy timestamps into a neutral clip", () => {
    expect(normalizeVoiceClips({ startTime: 4, endTime: 19 })).toEqual([
      { label: "neutral", startTime: 4, endTime: 19 },
    ]);
  });

  it("sorts styles canonically and selects neutral as primary", () => {
    const clips = normalizeVoiceClips({
      startTime: 0,
      endTime: 10,
      voiceClips: [
        { label: "soft", startTime: 40, endTime: 50 },
        { label: "neutral", startTime: 5, endTime: 15 },
      ],
    });

    expect(clips.map((clip) => clip.label)).toEqual(["neutral", "soft"]);
    expect(primaryVoiceClip(clips).startTime).toBe(5);
  });

  it("rejects duplicate labels and clips longer than 30 seconds", () => {
    expect(() =>
      normalizeVoiceClips({
        startTime: 0,
        endTime: 10,
        voiceClips: [
          { label: "neutral", startTime: 0, endTime: 10 },
          { label: "neutral", startTime: 20, endTime: 60 },
        ],
      })
    ).toThrow();
  });

  it("round-trips persisted clips and falls back safely", () => {
    const value = serializeVoiceClips([
      { label: "neutral", startTime: 2, endTime: 12 },
      { label: "dialogue", startTime: 30, endTime: 42 },
    ]);
    expect(parseStoredVoiceClips(value, { startTime: 0, endTime: 10 })).toHaveLength(2);
    expect(
      parseStoredVoiceClips("not-json", { startTime: 1, endTime: 11 })
    ).toEqual([{ label: "neutral", startTime: 1, endTime: 11 }]);
  });
});
