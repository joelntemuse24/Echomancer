import { describe, expect, it } from "vitest";
import { narrationProgressPercent } from "./narration-progress";

describe("narrationProgressPercent", () => {
  it("stays at 0 until a section is stored", () => {
    expect(narrationProgressPercent(0, 24)).toBe(0);
    expect(narrationProgressPercent(0, 0)).toBe(0);
  });

  it("is the real ratio, so the first section of a long book is not 99%", () => {
    expect(narrationProgressPercent(1, 24)).toBe(4);
    expect(narrationProgressPercent(1, 40)).toBe(3);
    expect(narrationProgressPercent(12, 24)).toBe(50);
  });

  it("reaches 99 only when that is the rounded share, and 100 when every section is stored", () => {
    expect(narrationProgressPercent(99, 100)).toBe(99);
    expect(narrationProgressPercent(1, 1)).toBe(100);
    expect(narrationProgressPercent(24, 24)).toBe(100);
  });
});
