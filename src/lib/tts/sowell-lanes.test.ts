import { describe, expect, it } from "vitest";
import { formatSowellRequestLog, readSowellTimingHeaders } from "./sowell-timing";
import { planSowellLanes, sowellBookLanes, SOWELL_LANE_HARD_CEILING } from "./sowell-voice";

describe("sowell lanes", () => {
  it("keeps the live default at two and refuses a cap past the ceiling", () => {
    expect(sowellBookLanes({} as NodeJS.ProcessEnv)).toBe(2);
    expect(sowellBookLanes({ SOWELL_BOOK_LANES: "4" } as NodeJS.ProcessEnv)).toBe(4);
    expect(sowellBookLanes({ SOWELL_BOOK_LANES: "100" } as NodeJS.ProcessEnv)).toBe(
      SOWELL_LANE_HARD_CEILING
    );
    expect(sowellBookLanes({ SOWELL_BOOK_LANES: "0" } as NodeJS.ProcessEnv)).toBe(1);
  });

  it("uses one lane for one section and two for the 1480-character book", () => {
    expect(planSowellLanes({ remainingSections: 1, cap: 2 })).toBe(1);
    expect(planSowellLanes({ remainingSections: 2, cap: 2 })).toBe(2);
    expect(planSowellLanes({ remainingSections: 10, cap: 2 })).toBe(2);
    expect(planSowellLanes({ remainingSections: 10, cap: 4 })).toBe(4);
    expect(planSowellLanes({ remainingSections: 10, cap: 100 })).toBe(8);
  });
});

describe("sowell request log", () => {
  it("keeps ids and timings and drops the spoken text", () => {
    const headers = new Headers({
      "x-sowell-infer-ms": "12000",
      "x-sowell-load-ms": "3400",
      "x-sowell-first-audio-ms": "7900",
      "x-sowell-audio-ms": "38125",
      "x-sowell-init": "1",
    });
    const line = formatSowellRequestLog({
      jobId: "949891ec-24a2-4ff1-97d9-db5a933af69a",
      section: 0,
      attempt: 0,
      chars: 739,
      status: 200,
      headerMs: 41000,
      bodyMs: 800,
      bytes: 1_830_044,
      ...readSowellTimingHeaders(headers),
    });
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      event: "sowell_request",
      jobId: "949891ec-24a2-4ff1-97d9-db5a933af69a",
      section: 0,
      chars: 739,
      headerMs: 41000,
      bodyMs: 800,
      inferMs: 12000,
      loadMs: 3400,
      init: 1,
    });
    expect(line).not.toMatch(/harbor|Bearer|modal\.run/i);
  });
});
