import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAYBACK_SPEED,
  PLAYBACK_SPEED_PRESETS,
  nextPlaybackSpeed,
} from "./playback-speed";

describe("PLAYBACK_SPEED_PRESETS", () => {
  it("keeps a short set with 1x as the default", () => {
    expect(PLAYBACK_SPEED_PRESETS).toEqual([0.8, 1, 1.5]);
    expect(DEFAULT_PLAYBACK_SPEED).toBe(1);
  });

  it("cycles the quiet speed control", () => {
    expect(nextPlaybackSpeed(1)).toBe(1.5);
    expect(nextPlaybackSpeed(1.5)).toBe(0.8);
    expect(nextPlaybackSpeed(0.8)).toBe(1);
    expect(nextPlaybackSpeed(2)).toBe(1.5);
  });
});
