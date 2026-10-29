/**
 * ETA traces use fixed timestamps (epoch seconds) so the numbers are the
 * arithmetic, not the clock. The old estimator divided sections by time since
 * generation started, so queueing and startup looked like fast progress and the
 * estimate collapsed as the job went on.
 */

import { describe, expect, it } from "vitest";
import {
  computeJobEta,
  estimateJobEtaSeconds,
  estimateLiveEtaSeconds,
  formatEtaSeconds,
  finalizeEtaSeconds,
  smoothEta,
  type JobEtaInput,
} from "./eta";

function job(patch: Partial<JobEtaInput>): JobEtaInput {
  return {
    status: "processing",
    total_sections: 20,
    current_section: 0,
    generation_started_at: 1_000,
    now: 1_100,
    ...patch,
  };
}

describe("computeJobEta", () => {
  it("stays in the estimating state with a friendly label until there is enough to measure", () => {
    const eta = computeJobEta(
      job({
        current_section: 2,
        first_section_at: 1_005,
        last_section_at: 1_080,
        now: 1_100,
      })
    );

    expect(eta.state).toBe("estimating");
    expect(eta.label).toBe("Estimating…");
    expect(eta.seconds).not.toBeNull();
    expect(eta.seconds!).toBeGreaterThan(0);
  });

  it("switches to the measured rate after 3 sections and 30s of throughput", () => {
    const eta = computeJobEta(
      job({
        current_section: 4,
        first_section_at: 1_000,
        last_section_at: 1_120,
        now: 1_120,
      })
    );

    expect(eta.state).toBe("live");
    expect(eta.label).toMatch(/^(under a minute|~\d+ min|~\d+h)/);
    expect(eta.label).not.toMatch(/^~0 min$/);
  });

  it("heuristic fallback divides by an explicit fanout of 1 by default", () => {
    const single = computeJobEta(
      job({
        status: "queued",
        current_section: 0,
        total_sections: 20,
        generation_started_at: null,
        created_at: 1_000,
        now: 1_010,
        latency_class: "balanced",
      })
    );
    const explicitOne = computeJobEta(
      job({
        status: "queued",
        current_section: 0,
        total_sections: 20,
        generation_started_at: null,
        created_at: 1_000,
        now: 1_010,
        latency_class: "balanced",
        fanout: 1,
      })
    );
    const fanoutFour = computeJobEta(
      job({
        status: "queued",
        current_section: 0,
        total_sections: 20,
        generation_started_at: null,
        created_at: 1_000,
        now: 1_010,
        latency_class: "balanced",
        fanout: 4,
      })
    );

    // 20 sections × 16s + 15s finalize.
    expect(explicitOne.seconds).toBe(335);
    expect(single.seconds).toBe(explicitOne.seconds);
    expect(fanoutFour.seconds).toBe(95);
    expect(single.seconds!).toBeGreaterThan(fanoutFour.seconds! * 3);
  });

  it("uses character weights when per-section sizes are known", () => {
    const even = computeJobEta(
      job({
        current_section: 2,
        total_sections: 4,
        first_section_at: 1_000,
        last_section_at: 1_100,
        now: 1_100,
        section_chars: [100, 100, 100, 100],
      })
    );
    const heavyTail = computeJobEta(
      job({
        current_section: 2,
        total_sections: 4,
        first_section_at: 1_000,
        last_section_at: 1_100,
        now: 1_100,
        section_chars: [50, 50, 400, 400],
      })
    );

    expect(heavyTail.seconds!).toBeGreaterThan(even.seconds!);
  });

  it("grows, and does not collapse, when a fast start turns into a slow tail", () => {
    // Sections land every 10s for the first five, then one every 90s. A rate
    // measured from generation start (queue + startup) would keep the ETA low
    // and then crash to zero as the tail dragged.
    const start = 1_000;
    const finishes = [1_010, 1_020, 1_030, 1_040, 1_050, 1_140, 1_230, 1_320];
    const total = 20;

    let prev: { seconds: number; at: number } | null = null;
    const trace: number[] = [];
    for (let i = 0; i < finishes.length; i++) {
      const now = finishes[i]!;
      const eta = computeJobEta(
        job({
          current_section: i + 1,
          total_sections: total,
          generation_started_at: start,
          first_section_at: finishes[0],
          last_section_at: now,
          now,
        }),
        prev
      );
      trace.push(eta.seconds!);
      prev = { seconds: eta.seconds!, at: now };
    }

    // The fast start pulls the estimate down (that part was genuinely fast),
    // and the slow tail then pushes it back up. What must not happen is the
    // old collapse: a rate divided by time since generation started kept
    // shrinking toward zero while the tail dragged.
    const lowest = Math.min(...trace);
    const last = trace[trace.length - 1]!;
    expect(last).toBeGreaterThan(lowest);
    expect(lowest).toBeGreaterThan(60);
    expect(last).toBeGreaterThan(lowest * 1.1);
    for (let i = 0; i < trace.length; i++) {
      expect(trace[i]!).toBeGreaterThan(0);
      if (i > 0) {
        // The ±25% clamp holds across the transition. Upward moves are judged
        // against the previous value so an exhausted estimate can still grow.
        expect(trace[i]!).toBeLessThanOrEqual(
          Math.round(Math.max(trace[i - 1]!, trace[i - 1]! - 10) * 1.26 + 1)
        );
      }
    }
  });

  it("grows the estimate during a long stall instead of freezing", () => {
    const base = {
      current_section: 6,
      total_sections: 30,
      first_section_at: 1_005,
      last_section_at: 1_100,
    };
    const moving = computeJobEta(job({ ...base, now: 1_130 }));
    const stalled = computeJobEta(job({ ...base, now: 1_400 }));

    expect(moving.state).toBe("live");
    expect(stalled.seconds!).toBeGreaterThan(moving.seconds!);
    // 300s of silence against a ~19s mean interval leaves ~262s of excess.
    expect(stalled.seconds! - moving.seconds!).toBeGreaterThan(100);
  });

  it("measures throughput from section finishes, so silence does not dilute the rate", () => {
    const base = {
      current_section: 6,
      total_sections: 30,
      first_section_at: 1_005,
      last_section_at: 1_100,
    };
    const atLast = computeJobEta(job({ ...base, now: 1_100 }));
    const shortlyAfter = computeJobEta(job({ ...base, now: 1_130 }));

    expect(atLast.state).toBe("live");
    // Before the stall threshold (2× the mean interval) the silence adds
    // nothing, and it must not slow the measured rate either.
    expect(shortlyAfter.seconds).toBe(atLast.seconds);
  });

  it("smoothEta counts down the previous estimate and clamps the move", () => {
    expect(smoothEta(null, 300, 1_000)).toBe(300);
    // 590s counted down, blended 30% toward the server's 300s.
    expect(smoothEta({ seconds: 600, at: 1_100 }, 300, 1_110)).toBe(503);
    // A huge jump up is held to +25% of the previous estimate.
    expect(smoothEta({ seconds: 100, at: 1_000 }, 10_000, 1_000)).toBe(125);
    // No value below a second while work remains.
    expect(smoothEta({ seconds: 5, at: 1_000 }, 0, 1_100)).toBe(
      smoothEta(null, 1, 1_100)
    );
  });

  it("includes the finalize step instead of reporting zero when sections finish", () => {
    const eta = computeJobEta(
      job({
        current_section: 20,
        total_sections: 20,
        first_section_at: 1_000,
        last_section_at: 1_300,
        now: 1_310,
      })
    );

    expect(eta.state).toBe("finalizing");
    expect(eta.seconds).toBe(finalizeEtaSeconds(20));
    expect(eta.seconds!).toBeGreaterThanOrEqual(15);
    expect(eta.seconds!).toBeLessThanOrEqual(600);
    expect(eta.label).not.toBeNull();
  });

  it("caps the finalize estimate at ten minutes", () => {
    expect(finalizeEtaSeconds(0)).toBe(15);
    expect(finalizeEtaSeconds(10)).toBe(17);
    expect(finalizeEtaSeconds(100_000)).toBe(600);
  });

  it("never reports 0 or '~0 min' while work remains", () => {
    const traces: JobEtaInput[] = [
      job({ status: "queued", current_section: 0, total_sections: 20 }),
      job({ current_section: 1, first_section_at: 1_000, last_section_at: 1_000 }),
      job({ current_section: 19, total_sections: 20, now: 1_100 }),
      job({ current_section: 20, total_sections: 20 }),
      job({ status: "processing", total_sections: 0, char_count: 4_000, now: 1_100 }),
    ];

    for (const trace of traces) {
      const eta = computeJobEta(trace);
      expect(eta.seconds).not.toBeNull();
      expect(eta.seconds!).toBeGreaterThanOrEqual(1);
      if (eta.state !== "estimating") {
        expect(eta.label).not.toMatch(/\b0 min\b/);
      }
    }
  });

  it("reports done only when the job is ready", () => {
    expect(computeJobEta(job({ status: "ready", current_section: 20 })).state).toBe(
      "done"
    );
    expect(
      computeJobEta(job({ status: "failed" })).state
    ).toBe("done");
    expect(estimateJobEtaSeconds(job({ status: "ready" }))).toBeNull();
  });

  it("smooths successive polls and clamps a single jump to ±25%", () => {
    const first = computeJobEta(
      job({ current_section: 4, first_section_at: 1_000, last_section_at: 1_100, now: 1_100 })
    );
    const prev = { seconds: 600, at: 1_100 };

    // A sudden jump down (a burst) may not move more than 25% at once.
    const jumpDown = computeJobEta(
      job({
        current_section: 12,
        total_sections: 40,
        first_section_at: 1_000,
        last_section_at: 1_110,
        now: 1_110,
      }),
      prev
    );
    expect(jumpDown.seconds!).toBeGreaterThanOrEqual(600 * 0.75 - 2);

    // A sudden jump up is held to +25% of the counted-down value.
    const jumpUp = computeJobEta(
      job({
        current_section: 4,
        total_sections: 200,
        first_section_at: 1_000,
        last_section_at: 1_095,
        now: 1_110,
      }),
      prev
    );
    expect(jumpUp.seconds!).toBeLessThanOrEqual(600 * 1.25 + 2);
    expect(jumpUp.seconds!).toBeGreaterThan(first.seconds! * 0.5);
  });

  it("counts the previous estimate down before blending", () => {
    const target = {
      current_section: 6,
      total_sections: 20,
      first_section_at: 1_000,
      last_section_at: 1_095,
      now: 1_110,
    };
    const fresh = computeJobEta(job(target));
    const stalePrev = computeJobEta(job(target), { seconds: 900, at: 1_010 });

    expect(fresh.state).toBe("live");
    expect(stalePrev.seconds!).toBeLessThan(900);
    expect(stalePrev.seconds!).toBeGreaterThan(fresh.seconds!);
  });

  it("keeps consecutive estimates monotone-ish (never more than 25% per poll)", () => {
    let prev: { seconds: number; at: number } | null = null;
    let last: number | null = null;
    for (let i = 0; i < 12; i++) {
      const now = 1_100 + i * 10;
      const eta = computeJobEta(
        job({
          current_section: 4,
          total_sections: 60,
          first_section_at: 1_000,
          last_section_at: now,
          now,
        }),
        prev
      );
      expect(eta.seconds).not.toBeNull();
      if (last != null) {
        expect(eta.seconds!).toBeGreaterThanOrEqual(Math.round(last * 0.74));
        expect(eta.seconds!).toBeLessThanOrEqual(Math.round(last * 1.26));
      }
      prev = { seconds: eta.seconds!, at: now };
      last = eta.seconds!;
    }
  });

  it("handles a steady fanout of 4 without assuming it in the heuristic", () => {
    // Eight sections in 100s is two sections per 25s: the measured rate
    // already includes all four lanes.
    const eta = computeJobEta(
      job({
        current_section: 8,
        total_sections: 40,
        first_section_at: 1_000,
        last_section_at: 1_100,
        now: 1_100,
      })
    );

    expect(eta.state).toBe("live");
    // 32 remaining / (7 sections per 100s) ≈ 457s, plus ~15s finalize.
    expect(eta.seconds!).toBeGreaterThan(400);
    expect(eta.seconds!).toBeLessThan(560);
  });
});

describe("legacy exports", () => {
  it("estimateLiveEtaSeconds returns the measured or finalize value", () => {
    expect(
      estimateLiveEtaSeconds(
        job({ current_section: 1, first_section_at: 1_000, now: 1_100 })
      )
    ).toBeNull();
    expect(
      estimateLiveEtaSeconds(
        job({ current_section: 6, first_section_at: 1_000, last_section_at: 1_100 })
      )
    ).toBeGreaterThan(0);
    expect(
      estimateLiveEtaSeconds(job({ current_section: 20, total_sections: 20 }))
    ).toBeGreaterThan(0);
  });

  it("estimateJobEtaSeconds delegates and never returns 0 for running work", () => {
    const eta = estimateJobEtaSeconds(
      job({ current_section: 20, total_sections: 20 })
    );
    expect(eta).toBe(finalizeEtaSeconds(20));
  });

  it("formatEtaSeconds stays the label formatter", () => {
    expect(formatEtaSeconds(10)).toBe("under a minute");
    expect(formatEtaSeconds(60)).toBe("~1 min");
    expect(formatEtaSeconds(180)).toBe("~3 min");
    expect(formatEtaSeconds(null)).toBeNull();
  });
});
