import { describe, expect, it } from "vitest";
import { SKIP_SECONDS, clampSeekSeconds } from "./seek";

describe("clampSeekSeconds", () => {
  it("skips forward and back by ten seconds inside the file", () => {
    expect(SKIP_SECONDS).toBe(10);
    expect(clampSeekSeconds(30, SKIP_SECONDS, 90)).toBe(40);
    expect(clampSeekSeconds(30, -SKIP_SECONDS, 90)).toBe(20);
  });

  it("clamps to the start and end of the file", () => {
    expect(clampSeekSeconds(4, -SKIP_SECONDS, 90)).toBe(0);
    expect(clampSeekSeconds(88, SKIP_SECONDS, 90)).toBe(90);
    expect(clampSeekSeconds(12, SKIP_SECONDS, 0)).toBe(0);
    expect(clampSeekSeconds(Number.NaN, SKIP_SECONDS, 90)).toBe(10);
  });
});
