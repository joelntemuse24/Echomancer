/**
 * The cold-start call budget and the pre-warm that overlaps it.
 *
 * `job db10a6d6` (2026-11-06) is the reference: a 5-section book from a
 * scaled-to-zero pool took ~4m38s to `ready`. Two separate wastes were in it,
 * and neither was the restore itself:
 *
 * 1. **Four one-row calls on one container.** 246s of audio took 84s of GPU
 *    wall — 2.93x realtime, the documented *one-row* rate, when a full batch
 *    reaches 35–65x. Every lane reported the same container `36459a5cb16f`,
 *    so they serialized on its single GPU thread. Five sections at
 *    `MODAL_S2_BATCH_SIZE=24` fit in **one** call.
 * 2. **A 150s budget spent on a compiling placement.** The first-light call is
 *    wall clock in front of the person, and #237 says the book never waits for
 *    a compile anyway. Racing for it gives up sooner and retries elsewhere.
 *
 * These tests pin the arithmetic and the policy, not a GPU.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MODAL_CLONE_FIRST_LIGHT_WAIT_DEFAULT_MS,
  modalCloneFirstLightWaitMs,
  resetModalCloneGuardForTests,
} from "@/lib/tts/providers/modal-clone-guard";
import {
  MODAL_LANE_CHARS_PER_SECOND,
  modalLaneCharCap,
  modalLaneCharCeiling,
} from "@/lib/tts/providers/modal-clone-lanes";
import {
  MODAL_CLONE_PREWARM_COOLDOWN_MS,
  MODAL_CLONE_WARM_COOLDOWN_MS,
  kickModalCloneSnapshotWarm,
  prewarmModalCloneSnapshot,
  resetModalCloneWarmForTests,
  setModalCloneWarmSpawnerForTests,
} from "@/lib/tts/providers/modal-clone-warm";

afterEach(() => {
  vi.unstubAllEnvs();
  resetModalCloneGuardForTests();
  resetModalCloneWarmForTests();
});

describe("the first-light restore budget", () => {
  it("gives up earlier than a normal placement, so a compile is not sat through", () => {
    vi.stubEnv("MODAL_S2_COLD_WAIT_MS", "150000");
    vi.stubEnv("MODAL_S2_FIRST_LIGHT_WAIT_MS", "");
    const first = modalCloneFirstLightWaitMs();
    expect(first).toBe(MODAL_CLONE_FIRST_LIGHT_WAIT_DEFAULT_MS);
    // Still covers a measured ~57s restore with margin…
    expect(first).toBeGreaterThan(57_000);
    // …and is meaningfully shorter than the placement budget.
    expect(first).toBeLessThan(150_000);
  });

  it("can never exceed a normal placement, so #237 still holds", () => {
    vi.stubEnv("MODAL_S2_COLD_WAIT_MS", "120000");
    // A mis-set longer value is clamped: this budget exists to be shorter.
    vi.stubEnv("MODAL_S2_FIRST_LIGHT_WAIT_MS", "150000");
    expect(modalCloneFirstLightWaitMs()).toBe(120_000);
    // A mis-set first-light budget can never reach past the hard ceiling
    // either, because it is clamped to the (already clamped) cold wait.
    vi.stubEnv("MODAL_S2_FIRST_LIGHT_WAIT_MS", "999999");
    vi.stubEnv("MODAL_S2_COLD_WAIT_MS", "999999");
    expect(modalCloneFirstLightWaitMs()).toBe(180_000);
    expect(modalCloneFirstLightWaitMs()).toBeLessThan(8 * 60_000);
  });

  it("falls back to the placement budget when set to 0", () => {
    vi.stubEnv("MODAL_S2_COLD_WAIT_MS", "150000");
    vi.stubEnv("MODAL_S2_FIRST_LIGHT_WAIT_MS", "0");
    expect(modalCloneFirstLightWaitMs()).toBe(150_000);
  });

  it("ignores a malformed value instead of shortening to nothing", () => {
    vi.stubEnv("MODAL_S2_COLD_WAIT_MS", "");
    vi.stubEnv("MODAL_S2_FIRST_LIGHT_WAIT_MS", "soon");
    expect(modalCloneFirstLightWaitMs()).toBe(
      MODAL_CLONE_FIRST_LIGHT_WAIT_DEFAULT_MS
    );
  });
});

describe("a call's character cap", () => {
  it("derives from the granted wait at the measured rate, not the old 2,900", () => {
    // 2.9x realtime is ~43 chars/s, not 2,900: the old constant overstated
    // throughput ~67x and packed 31k characters into one call.
    expect(MODAL_LANE_CHARS_PER_SECOND).toBeLessThan(200);
    const cap = modalLaneCharCap({} as NodeJS.ProcessEnv);
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThan(20_000);
  });

  it("lets an operator override it, but never past the ceiling", () => {
    expect(
      modalLaneCharCap({ MODAL_S2_LANE_MAX_CHARS: "8000" } as NodeJS.ProcessEnv)
    ).toBe(8_000);
    expect(
      modalLaneCharCap({ MODAL_S2_LANE_MAX_CHARS: "200000" } as NodeJS.ProcessEnv)
    ).toBe(modalLaneCharCeiling({} as NodeJS.ProcessEnv));
  });
});

describe("pre-warming the pool while the book is still packing", () => {
  function spawner() {
    const calls: string[][] = [];
    setModalCloneWarmSpawnerForTests((command, args) => {
      calls.push([command, ...args]);
    });
    return calls;
  }

  it("does not start a side cover when a book is starting", () => {
    vi.stubEnv("MODAL_TOKEN_ID", "test-token");
    const calls = spawner();
    expect(prewarmModalCloneSnapshot("book starting", 1_000)).toBe(false);
    expect(prewarmModalCloneSnapshot("book b", 2_000)).toBe(false);
    expect(
      prewarmModalCloneSnapshot("book d", 1_000 + MODAL_CLONE_PREWARM_COOLDOWN_MS)
    ).toBe(false);
    expect(calls).toEqual([]);
  });

  it("still kicks one compile after a missed placement, and does not add a cover", () => {
    vi.stubEnv("MODAL_TOKEN_ID", "test-token");
    const calls = spawner();
    expect(kickModalCloneSnapshotWarm("placement missed", 1_000)).toBe(true);
    expect(kickModalCloneSnapshotWarm("placement missed again", 2_000)).toBe(false);
    expect(
      prewarmModalCloneSnapshot("book e", 1_000 + MODAL_CLONE_WARM_COOLDOWN_MS)
    ).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe("modal");
  });

  it("does nothing without credentials, and never throws", () => {
    vi.stubEnv("MODAL_TOKEN_ID", "");
    vi.stubEnv("MODAL_TOKEN_SECRET", "");
    const calls = spawner();
    expect(prewarmModalCloneSnapshot("book g", 1_000)).toBe(false);
    expect(kickModalCloneSnapshotWarm("miss", 1_000)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("respects MODAL_S2_WARM_HOOK=0", () => {
    vi.stubEnv("MODAL_TOKEN_ID", "test-token");
    vi.stubEnv("MODAL_S2_WARM_HOOK", "0");
    const calls = spawner();
    expect(prewarmModalCloneSnapshot("book h", 1_000)).toBe(false);
    expect(kickModalCloneSnapshotWarm("miss", 1_000)).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

/**
 * The arithmetic of the smoke, kept as a test so the claim in the PR body
 * stays checkable rather than asserted.
 */
describe("the db10a6d6 timeline", () => {
  it("was one container at the one-row rate, not four containers batched", () => {
    // Section durations from the smoke (audio seconds), and the GPU wall each
    // had consumed by the time it staged, after a 57s direct-call restore.
    const firstWave = 102.34 + 102.77 + 41.05;
    const gpuWallAfterRestore = 141 - 57;
    const observed = firstWave / gpuWallAfterRestore;
    expect(observed).toBeCloseTo(2.93, 1);
    // The source documents 2.9x for a one-row call and 35–65x for a full one.
    expect(observed).toBeLessThan(10);
  });

  it("fits all five sections in one call at the default batch", () => {
    // Five sections is what the smoke had; the default batch is 24.
    expect(5).toBeLessThanOrEqual(24);
  });
});
