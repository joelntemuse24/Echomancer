import { describe, expect, it } from "vitest";
import {
  durationsFromSectionStarts,
  relocateSections,
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

describe("relocateSections", () => {
  const bodies = ["First body here.", "Second body is longer.", "Third.", "Fourth and last body."];
  const text = bodies.join("\n\n");

  function drifted(list: string[]) {
    let at = 0;
    return list.map((body) => {
      const section = { charStart: at, charEnd: at + body.length, text: body };
      at += body.length;
      return section;
    });
  }

  it("moves running-sum offsets onto the paragraph-separated text", () => {
    const moved = relocateSections(drifted(bodies), text);
    for (const section of moved) {
      expect(text.slice(section.charStart, section.charEnd)).toBe(section.text);
    }
    expect(moved[3]!.charStart).toBe(text.indexOf("Fourth"));
  });

  it("carries the drift past a section it cannot find", () => {
    const sections = drifted(bodies);
    sections[2] = { ...sections[2]!, text: "Not in the text at all." };
    const moved = relocateSections(sections, text);
    // Section 1 sits 2 chars past its packed offset, and the missing one inherits that.
    expect(moved[2]!.charStart).toBe(sections[2]!.charStart + 2);
    expect(moved[3]!.charStart).toBe(text.indexOf("Fourth"));
  });

  it("keeps a run of missing sections inside the text", () => {
    const sections = drifted(bodies).map((section) => ({ ...section, text: "zzz" }));
    const moved = relocateSections(sections, text);
    for (const section of moved) {
      expect(section.charStart).toBeGreaterThanOrEqual(0);
      expect(section.charEnd).toBeLessThanOrEqual(text.length);
    }
  });

  it("walks forward so a repeated body maps to its own place", () => {
    const repeated = ["Same line.", "Same line."];
    const moved = relocateSections(drifted(repeated), repeated.join("\n\n"));
    expect(moved.map((section) => section.charStart)).toEqual([0, 12]);
  });

  it("handles empty input", () => {
    expect(relocateSections([], text)).toEqual([]);
    const sections = drifted(bodies);
    expect(relocateSections(sections, "")).toEqual(sections);
  });
});
