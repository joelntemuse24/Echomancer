/**
 * The snapshot gate, and the bug it replaces.
 *
 * PR #324 decided a book was "proved cold" from
 * `!ready && sawWarmCount && warm <= 0`. `/ready` reports `warm_containers` as
 * only containers that have **finished restoring**, so an idle
 * `min_containers=0` pool — the normal resting state of the app — answers
 * exactly `ready: false, warm_containers: 0`. That refused the H100 and routed
 * the book to hosted Fish at 3–5× the cost, on the first book after any idle
 * period.
 *
 * The replacements are: decide from `starting_containers` and a recorded
 * snapshot marker; default to WAITING for the GPU; and make Fish reachable only
 * through an explicit flag.
 */

import { describe, expect, it } from "vitest";
import {
  classifySnapshotGate,
  decideSnapshotGate,
  formatSnapshotGateLog,
  gateAllowsGpu,
  snapshotBuildFallbackEnabled,
  type SnapshotGateProbe,
} from "@/lib/tts/providers/modal-clone-snapshot-gate";

function probe(overrides: Partial<SnapshotGateProbe> = {}): SnapshotGateProbe {
  return {
    answered: true,
    routePresent: true,
    ready: false,
    warmContainers: 0,
    startingContainers: 0,
    snapshotRecorded: true,
    build: "4eefb28b9308",
    ...overrides,
  };
}

describe("the idle pooled is not proved cold", () => {
  it("waits for an idle pool that has a recorded snapshot", () => {
    // This is the shape PR 324's gate refused: zero warm containers is the
    // normal rest state, not evidence that a placement would compile.
    const decision = classifySnapshotGate(probe());
    expect(decision).toEqual({ action: "wait", reason: "recorded-snapshot" });
    expect(gateAllowsGpu(decision)).toBe(false);
  });

  it("waits, and never falls back, for an idle pool with an unknown marker", () => {
    // A build from before the field cannot answer. That is "unknown", not
    // "would compile", so it waits — the same wait a real cold start gets.
    const decision = classifySnapshotGate(probe({ snapshotRecorded: null }));
    expect(decision).toEqual({ action: "wait", reason: "idle-unknown" });
  });

  it("does not fall back even when the marker says no", () => {
    // `false` only means "nothing here proves a restore". The marker can be
    // missing because the Dict write failed or a deploy invalidated snapshots,
    // so it is still not proof that a placement would compile.
    expect(classifySnapshotGate(probe({ snapshotRecorded: false }))).toEqual({
      action: "wait",
      reason: "idle-unknown",
    });
  });
});

describe("a starting container is a restore already underway", () => {
  it("uses the GPU instead of waiting or switching", () => {
    // `starting_containers` is what a warm count hides. The expensive work is
    // already happening, so switching engines would add a second bill rather
    // than save the first.
    expect(
      classifySnapshotGate(probe({ startingContainers: 1, snapshotRecorded: null }))
    ).toEqual({ action: "use-gpu", reason: "starting" });
  });

  it("wins over a warm count of zero even with no marker", () => {
    expect(
      classifySnapshotGate(
        probe({ startingContainers: 2, warmContainers: 0, snapshotRecorded: false })
      )
    ).toEqual({ action: "use-gpu", reason: "starting" });
  });
});

describe("a warm container is usable", () => {
  it("uses the GPU", () => {
    expect(
      classifySnapshotGate(probe({ ready: true, warmContainers: 1 }))
    ).toEqual({ action: "use-gpu", reason: "warm" });
  });
});

describe("an unanswered probe never changes the engine", () => {
  it("waits when the route is absent (a pre-/ready build)", () => {
    expect(
      classifySnapshotGate(probe({ routePresent: false, answered: false }))
    ).toEqual({ action: "wait", reason: "route-absent" });
  });

  it("waits when the probe timed out", () => {
    expect(classifySnapshotGate(probe({ answered: false }))).toEqual({
      action: "wait",
      reason: "probe-unanswered",
    });
  });

  it("does not fall back on an unanswered probe even with the flag on", () => {
    const decision = decideSnapshotGate(probe({ answered: false }), {
      MODAL_S2_SNAPSHOT_BUILD_FALLBACK: "1",
    });
    expect(decision.action).toBe("wait");
  });
});

describe("the fallback is opt-in and narrow", () => {
  it("is off unless explicitly enabled", () => {
    expect(snapshotBuildFallbackEnabled({})).toBe(false);
    expect(snapshotBuildFallbackEnabled({ MODAL_S2_SNAPSHOT_BUILD_FALLBACK: "0" })).toBe(false);
    expect(snapshotBuildFallbackEnabled({ MODAL_S2_SNAPSHOT_BUILD_FALLBACK: "1" })).toBe(true);
  });

  it("is reachable only for an idle pool with an unknown marker", () => {
    const env = { MODAL_S2_SNAPSHOT_BUILD_FALLBACK: "1" };
    expect(decideSnapshotGate(probe({ snapshotRecorded: null }), env)).toEqual({
      action: "fallback",
      reason: "idle-unknown",
    });
  });

  it("is not reachable for a recorded snapshot", () => {
    // A recorded snapshot means the next placement restores. Falling back would
    // pay 3-5x for a restore that was about to happen.
    expect(
      decideSnapshotGate(probe({ snapshotRecorded: true }), {
        MODAL_S2_SNAPSHOT_BUILD_FALLBACK: "1",
      }).action
    ).toBe("wait");
  });

  it("is not reachable while a container is starting", () => {
    expect(
      decideSnapshotGate(probe({ startingContainers: 1, snapshotRecorded: null }), {
        MODAL_S2_SNAPSHOT_BUILD_FALLBACK: "1",
      }).action
    ).toBe("use-gpu");
  });

  it("is not reachable when the pool is warm", () => {
    expect(
      decideSnapshotGate(probe({ ready: true, warmContainers: 2 }), {
        MODAL_S2_SNAPSHOT_BUILD_FALLBACK: "1",
      }).action
    ).toBe("use-gpu");
  });
});

describe("formatSnapshotGateLog", () => {
  it("records warm and starting side by side, because their confusion was the bug", () => {
    const line = formatSnapshotGateLog(
      probe({ startingContainers: 1 }),
      classifySnapshotGate(probe({ startingContainers: 1 }))
    );
    expect(line).toContain("[S2 gate]");
    expect(line).toContain("action=use-gpu");
    expect(line).toContain("reason=starting");
    expect(line).toContain("warm=0");
    expect(line).toContain("starting=1");
  });

  it("says `unknown` for an absent marker rather than `no`", () => {
    // `no` would be a claim the probe cannot make.
    const line = formatSnapshotGateLog(
      probe({ snapshotRecorded: null }),
      classifySnapshotGate(probe({ snapshotRecorded: null }))
    );
    expect(line).toContain("snapshot=unknown");
    expect(line).not.toContain("snapshot=no");
  });

  it("says `-` when starting is not reported", () => {
    const line = formatSnapshotGateLog(
      probe({ startingContainers: null }),
      classifySnapshotGate(probe({ startingContainers: null }))
    );
    expect(line).toContain("starting=-");
  });
});
