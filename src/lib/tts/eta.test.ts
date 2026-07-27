import { describe, expect, it } from "vitest";
import {
  estimateElapsedSeconds,
  estimateJobEtaSeconds,
  estimateLiveEtaSeconds,
  estimateSectionCount,
  estimateTakehomeWallClockSeconds,
  formatElapsedSeconds,
  formatEtaSeconds,
  secondsPerSectionHeuristic,
} from "./eta";

describe("eta", () => {
  it("estimates section count from char budget", () => {
    expect(estimateSectionCount(8000, 800)).toBe(10);
    expect(estimateSectionCount(100, 800)).toBe(1);
  });

  it("uses latency class for pre-job wall clock", () => {
    const fast = estimateTakehomeWallClockSeconds({
      charCount: 8000,
      maxCharsPerRequest: 800,
      latencyClass: "fast",
    });
    const quality = estimateTakehomeWallClockSeconds({
      charCount: 8000,
      maxCharsPerRequest: 800,
      latencyClass: "quality",
    });
    expect(fast.sections).toBe(10);
    expect(fast.seconds).toBe(10 * secondsPerSectionHeuristic("fast"));
    expect(quality.seconds).toBeGreaterThan(fast.seconds);
  });

  it("formats ETA labels", () => {
    expect(formatEtaSeconds(30)).toBe("under a minute");
    expect(formatEtaSeconds(60)).toBe("~1 min");
    expect(formatEtaSeconds(10 * 60)).toBe("~10 min");
    expect(formatEtaSeconds(90 * 60)).toBe("~1h 30m");
  });

  it("formats elapsed labels", () => {
    expect(formatElapsedSeconds(12)).toBe("12s");
    expect(formatElapsedSeconds(90)).toBe("1m 30s");
    expect(formatElapsedSeconds(3600)).toBe("1h");
  });

  it("reports elapsed while generating and clears when finished", () => {
    const now = Date.now() / 1000;
    expect(
      estimateElapsedSeconds({
        status: "processing",
        generation_started_at: now - 23,
      })
    ).toBe(23);
    expect(
      estimateElapsedSeconds({
        status: "ready",
        generation_started_at: now - 23,
      })
    ).toBeNull();
  });

  it("needs at least 2 sections for live ETA", () => {
    const now = Date.now() / 1000;
    expect(
      estimateLiveEtaSeconds({
        status: "processing",
        current_section: 1,
        total_sections: 100,
        generation_started_at: now - 60,
      })
    ).toBeNull();

    const eta = estimateLiveEtaSeconds({
      status: "processing",
      current_section: 10,
      total_sections: 100,
      generation_started_at: now - 100,
    });
    expect(eta).not.toBeNull();
    // 10 sections in 100s → 0.1/s → 90 remaining ≈ 900s
    expect(eta!).toBeGreaterThan(800);
    expect(eta!).toBeLessThan(1000);
  });

  it("falls back to heuristic when live ETA is unavailable", () => {
    const eta = estimateJobEtaSeconds({
      status: "queued",
      current_section: 0,
      total_sections: 50,
      latency_class: "fast",
    });
    expect(eta).toBe(50 * secondsPerSectionHeuristic("fast"));
  });
});
