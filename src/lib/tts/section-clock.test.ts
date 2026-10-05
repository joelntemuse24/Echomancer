import { describe, expect, it } from "vitest";
import {
  durationsFromSectionStarts,
  scaleSectionStarts,
  storedStartsMatchFile,
} from "./section-clock";

describe("scaleSectionStarts", () => {
  it("ends on the measured file when the frame sum is long", () => {
    const cbrTotal = 193_809.7;
    const full = 193_662.2;
    const partThree = 15 * 3600 + 15 * 60 + 59;
    const clock = scaleSectionStarts([partThree, cbrTotal - partThree], full);
    expect(clock.totalSeconds).toBe(full);
    expect(clock.sectionStarts[0]).toBe(0);
    expect(clock.sectionStarts[1]).toBeCloseTo((partThree / cbrTotal) * full, 5);
    const drift = partThree - clock.sectionStarts[1]!;
    expect(drift).toBeCloseTo(partThree * (1 - full / cbrTotal), 3);
    expect(drift).toBeGreaterThan(40);
    expect(drift).toBeLessThan(45);
  });

  it("keeps a stored clock only when it already matches the file", () => {
    const full = 193_662.2;
    expect(
      storedStartsMatchFile({ sectionStarts: [0, 10], totalSeconds: full + 1 }, full)
    ).toBe(true);
    expect(
      storedStartsMatchFile({ sectionStarts: [0, 10], totalSeconds: 193_809.7 }, full)
    ).toBe(false);
  });

  it("turns measured starts into per-section durations", () => {
    expect(durationsFromSectionStarts([0, 10, 25], 40)).toEqual([
      { index: 0, durationSeconds: 10 },
      { index: 1, durationSeconds: 15 },
      { index: 2, durationSeconds: 15 },
    ]);
  });
});
