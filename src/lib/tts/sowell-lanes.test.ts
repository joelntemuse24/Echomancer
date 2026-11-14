import { describe, expect, it } from "vitest";
import { formatSowellRequestLog, readSowellTimingHeaders } from "./sowell-timing";
import {
  sowellBookLanes,
  sowellFleetContainers,
  SOWELL_FLEET_CONTAINERS_DEFAULT,
  SOWELL_IN_FLIGHT,
  SOWELL_LANE_HARD_CEILING,
} from "./sowell-voice";

describe("sowell lanes", () => {
  it("defaults one book to six lanes and refuses a cap past the ceiling", () => {
    // Six is the deployed fleet (`SOWELL_MAX_CONTAINERS`). The old default of
    // two left four containers idle on every book.
    expect(SOWELL_IN_FLIGHT).toBe(6);
    expect(sowellBookLanes({} as NodeJS.ProcessEnv)).toBe(6);
    expect(sowellBookLanes({ SOWELL_BOOK_LANES: "4" } as NodeJS.ProcessEnv)).toBe(4);
    // A request past the hard ceiling is clamped, and the fleet clamps again.
    expect(sowellBookLanes({ SOWELL_BOOK_LANES: "100" } as NodeJS.ProcessEnv)).toBe(6);
    // The hard ceiling is now 16, so a 12-container fleet honours 12 lanes.
    expect(
      sowellBookLanes({
        SOWELL_BOOK_LANES: "100",
        SOWELL_MAX_CONTAINERS: "12",
      } as NodeJS.ProcessEnv)
    ).toBe(12);
    expect(sowellBookLanes({ SOWELL_BOOK_LANES: "0" } as NodeJS.ProcessEnv)).toBe(1);
    expect(sowellBookLanes({ SOWELL_BOOK_LANES: "abc" } as NodeJS.ProcessEnv)).toBe(6);
  });

  it("never asks for more lanes than the fleet has containers", () => {
    expect(SOWELL_FLEET_CONTAINERS_DEFAULT).toBe(6);
    expect(sowellFleetContainers({} as NodeJS.ProcessEnv)).toBe(6);
    // A ramped-down fleet clamps the book, so a lane is not spent on a 429.
    expect(
      sowellBookLanes({
        SOWELL_BOOK_LANES: "8",
        SOWELL_MAX_CONTAINERS: "3",
      } as NodeJS.ProcessEnv)
    ).toBe(3);
    // Sixteen is the hard ceiling and also the fleet ceiling.
    expect(SOWELL_LANE_HARD_CEILING).toBe(16);
    expect(
      sowellBookLanes({
        SOWELL_BOOK_LANES: "16",
        SOWELL_MAX_CONTAINERS: "12",
      } as NodeJS.ProcessEnv)
    ).toBe(12);
    expect(
      sowellBookLanes({
        SOWELL_BOOK_LANES: "16",
        SOWELL_MAX_CONTAINERS: "16",
      } as NodeJS.ProcessEnv)
    ).toBe(16);
    // A lone book can hold the whole 16-container fleet.
    expect(sowellBookLanes({ SOWELL_BOOK_LANES: "100", SOWELL_MAX_CONTAINERS: "20" } as NodeJS.ProcessEnv)).toBe(16);
    expect(sowellFleetContainers({ SOWELL_MAX_CONTAINERS: "0" } as NodeJS.ProcessEnv)).toBe(1);
    expect(
      sowellFleetContainers({ SOWELL_MAX_CONTAINERS: "999" } as NodeJS.ProcessEnv)
    ).toBe(16);
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
