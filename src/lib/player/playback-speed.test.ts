import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAYBACK_SPEED,
  PLAYBACK_SPEED_PRESETS,
  assignPlaybackRate,
  formatPlaybackSpeed,
  nextPlaybackSpeed,
  playbackSpeedsMatch,
  previousPlaybackSpeed,
} from "./playback-speed";

describe("playback speed", () => {
  it("starts a fresh listen at 1×", () => {
    expect(DEFAULT_PLAYBACK_SPEED).toBe(1);
    expect(formatPlaybackSpeed(DEFAULT_PLAYBACK_SPEED)).toBe("1×");
  });

  it("steps the existing 0.8–1.5 range by exactly 0.05", () => {
    expect(PLAYBACK_SPEED_PRESETS[0]).toBe(0.8);
    expect(PLAYBACK_SPEED_PRESETS.at(-1)).toBe(1.5);
    expect(PLAYBACK_SPEED_PRESETS).toContain(0.95);
    expect(PLAYBACK_SPEED_PRESETS).toContain(1.35);
    expect(PLAYBACK_SPEED_PRESETS).toHaveLength(15);
    for (let i = 1; i < PLAYBACK_SPEED_PRESETS.length; i++) {
      const step = Math.round(
        (PLAYBACK_SPEED_PRESETS[i]! - PLAYBACK_SPEED_PRESETS[i - 1]!) * 100
      );
      expect(step).toBe(5);
    }
  });

  it("labels every step without a float artifact", () => {
    expect(PLAYBACK_SPEED_PRESETS.map(formatPlaybackSpeed)).toEqual([
      "0.8×",
      "0.85×",
      "0.9×",
      "0.95×",
      "1×",
      "1.05×",
      "1.1×",
      "1.15×",
      "1.2×",
      "1.25×",
      "1.3×",
      "1.35×",
      "1.4×",
      "1.45×",
      "1.5×",
    ]);
  });

  it("cycles the whole dial and wraps at the ends", () => {
    let speed: number = PLAYBACK_SPEED_PRESETS[0]!;
    const seen = [speed];
    for (let i = 0; i < PLAYBACK_SPEED_PRESETS.length - 1; i++) {
      speed = nextPlaybackSpeed(speed);
      seen.push(speed);
    }
    expect(seen).toEqual([...PLAYBACK_SPEED_PRESETS]);
    expect(nextPlaybackSpeed(1.5)).toBe(0.8);
    expect(previousPlaybackSpeed(0.8)).toBe(1.5);
    expect(nextPlaybackSpeed(0.95)).toBe(1);
    expect(previousPlaybackSpeed(1.35)).toBe(1.3);
  });

  it("keeps an explicit 1.15× choice and does not invent one", () => {
    expect(playbackSpeedsMatch(1.15, 1.15)).toBe(true);
    expect(nextPlaybackSpeed(1.15)).toBe(1.2);
    expect(nextPlaybackSpeed(1.149999999)).toBe(1.2);
  });

  it("writes the chosen rate onto the media element", () => {
    const audio = { playbackRate: 1, defaultPlaybackRate: 1, preservesPitch: false };
    assignPlaybackRate(audio, 0.95);
    expect(audio.playbackRate).toBe(0.95);
    expect(audio.defaultPlaybackRate).toBe(0.95);
    expect(audio.preservesPitch).toBe(true);
    assignPlaybackRate(audio, DEFAULT_PLAYBACK_SPEED);
    expect(audio.playbackRate).toBe(1);
  });
});
