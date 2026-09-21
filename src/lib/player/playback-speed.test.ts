import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAYBACK_SPEED,
  PLAYBACK_SPEED_PRESETS,
  formatPlaybackSpeed,
  nextPlaybackSpeed,
} from "./playback-speed";

describe("PLAYBACK_SPEED_PRESETS", () => {
  it("offers fine listen-time steps including 1.15 and 1.25", () => {
    expect(PLAYBACK_SPEED_PRESETS).toEqual([
      0.8, 0.9, 1, 1.1, 1.15, 1.2, 1.25, 1.3, 1.4, 1.5,
    ]);
    expect(DEFAULT_PLAYBACK_SPEED).toBe(1);
  });

  it("cycles the quiet speed control through the fine set", () => {
    expect(nextPlaybackSpeed(1)).toBe(1.1);
    expect(nextPlaybackSpeed(1.1)).toBe(1.15);
    expect(nextPlaybackSpeed(1.15)).toBe(1.2);
    expect(nextPlaybackSpeed(1.2)).toBe(1.25);
    expect(nextPlaybackSpeed(1.25)).toBe(1.3);
    expect(nextPlaybackSpeed(1.5)).toBe(0.8);
    expect(nextPlaybackSpeed(0.8)).toBe(0.9);
    expect(nextPlaybackSpeed(2)).toBe(1.1);
  });

  it("labels the cycle control compactly", () => {
    expect(formatPlaybackSpeed(1)).toBe("1×");
    expect(formatPlaybackSpeed(1.15)).toBe("1.15×");
    expect(formatPlaybackSpeed(1.25)).toBe("1.25×");
    expect(formatPlaybackSpeed(1.5)).toBe("1.5×");
  });
});
