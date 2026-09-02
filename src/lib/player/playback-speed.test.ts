import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAYBACK_SPEED,
  PLAYBACK_SPEED_PRESETS,
} from "./playback-speed";

describe("PLAYBACK_SPEED_PRESETS", () => {
  it("includes slowdown pills and keeps 1x as the default", () => {
    expect(PLAYBACK_SPEED_PRESETS).toEqual([0.8, 0.9, 1, 1.25, 1.5, 2]);
    expect(DEFAULT_PLAYBACK_SPEED).toBe(1);
  });
});
