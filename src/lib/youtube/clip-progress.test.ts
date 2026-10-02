import { describe, expect, it } from "vitest";
import { clipPhaseFromStatus, clipWaitProgress } from "./clip-progress";

describe("clip wait progress", () => {
  it("creeps while the clip is fetching and steps up once the voice is preparing", () => {
    expect(clipWaitProgress(0, "starting")).toBe(0);
    expect(clipWaitProgress(4_000, "starting")).toBeCloseTo(0.12);
    expect(clipWaitProgress(0, "fetching")).toBe(0);
    expect(clipWaitProgress(40_000, "fetching")).toBeCloseTo(0.7);
    expect(clipWaitProgress(80_000, "fetching")).toBeCloseTo(0.7);
    expect(clipWaitProgress(0, "preparing")).toBeCloseTo(0.72);
    expect(clipWaitProgress(20_000, "preparing")).toBeCloseTo(0.95);
  });

  it("reads the worker phase", () => {
    expect(clipPhaseFromStatus("queued", null)).toBe("starting");
    expect(clipPhaseFromStatus("queued", "preparing")).toBe("starting");
    expect(clipPhaseFromStatus("running", "fetching")).toBe("fetching");
    expect(clipPhaseFromStatus("running", null)).toBe("fetching");
    expect(clipPhaseFromStatus("running", "preparing")).toBe("preparing");
  });
});
