/**
 * The off-path snapshot warm must be startable from a book timeout, and must
 * not start a second compile while the first one is still the right answer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MODAL_CLONE_COVER_ARGS,
  kickModalCloneSnapshotWarm,
  modalCloneWarmConfigured,
  resetModalCloneWarmForTests,
  setModalCloneWarmSpawnerForTests,
} from "./modal-clone-warm";

afterEach(() => {
  resetModalCloneWarmForTests();
  vi.unstubAllEnvs();
});

describe("off-path snapshot warm", () => {
  it("does nothing without a Modal token, so a book never shells out by accident", () => {
    const spawned: string[][] = [];
    setModalCloneWarmSpawnerForTests((command, args) => {
      spawned.push([command, ...args]);
    });
    expect(modalCloneWarmConfigured()).toBe(false);
    expect(kickModalCloneSnapshotWarm("placement exceeded restore budget")).toBe(false);
    expect(spawned).toEqual([]);
  });

  it("starts one RPC cover and ignores a second kick inside the cooldown", () => {
    vi.stubEnv("MODAL_TOKEN_ID", "test-token");
    vi.stubEnv("MODAL_S2_APP_NAME", "echomancer-s2-clone");
    const spawned: string[][] = [];
    setModalCloneWarmSpawnerForTests((command, args) => {
      spawned.push([command, ...args]);
    });
    expect(kickModalCloneSnapshotWarm("no answer within 150s", 1_000)).toBe(true);
    expect(kickModalCloneSnapshotWarm("no answer within 150s", 2_000)).toBe(false);
    expect(spawned).toEqual([["modal", ...MODAL_CLONE_COVER_ARGS]]);
    expect(MODAL_CLONE_COVER_ARGS).toContain("--rounds");
    expect(MODAL_CLONE_COVER_ARGS).toContain("1");
    expect(MODAL_CLONE_COVER_ARGS).toContain("--scaledown");
    expect(MODAL_CLONE_COVER_ARGS).toContain("0");
  });

  it("stays off when the hook is disabled, even with a token", () => {
    vi.stubEnv("MODAL_TOKEN_ID", "test-token");
    vi.stubEnv("MODAL_S2_WARM_HOOK", "0");
    const spawned: string[][] = [];
    setModalCloneWarmSpawnerForTests((command, args) => {
      spawned.push([command, ...args]);
    });
    expect(kickModalCloneSnapshotWarm("placement")).toBe(false);
    expect(spawned).toEqual([]);
  });
});
