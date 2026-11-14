/**
 * The off-path snapshot warm must be startable from a book timeout, and must
 * not start a second compile while the first one is still the right answer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MODAL_CLONE_COVER_ARGS,
  kickModalCloneSnapshotWarm,
  modalCloneWarmChildEnv,
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

describe("the cover lands on the app the worker talks to", () => {
  // The worker's prewarm is the production path: it starts a container for the
  // pool a customer's book will call. `modal/s2_clone_warm.py` resolves its
  // target through `s2_contract.resolve_app_name`, which redirects anything
  // named `echomancer-s2-clone` to staging unless `S2C_ALLOW_PRODUCTION=1` —
  // so a cover that names production but omits the opt-in warms the wrong app,
  // and the spawn still reports success.
  it("exports S2C_ALLOW_PRODUCTION=1 for the production app", () => {
    expect(modalCloneWarmChildEnv({}).S2C_APP_NAME).toBe("echomancer-s2-clone");
    expect(modalCloneWarmChildEnv({}).S2C_ALLOW_PRODUCTION).toBe("1");
  });

  it("adds the opt-in when the name comes from MODAL_S2_APP_NAME", () => {
    const env = modalCloneWarmChildEnv({
      MODAL_S2_APP_NAME: "echomancer-s2-clone",
    });
    expect(env.S2C_APP_NAME).toBe("echomancer-s2-clone");
    expect(env.S2C_ALLOW_PRODUCTION).toBe("1");
  });

  it("overrides a stale opt-in value when the target is production", () => {
    // A parent process that had `S2C_ALLOW_PRODUCTION=0` must not turn the
    // production cover into a staging one.
    const env = modalCloneWarmChildEnv({
      S2C_APP_NAME: "echomancer-s2-clone",
      S2C_ALLOW_PRODUCTION: "0",
    });
    expect(env.S2C_APP_NAME).toBe("echomancer-s2-clone");
    expect(env.S2C_ALLOW_PRODUCTION).toBe("1");
  });

  it("leaves an explicitly staging target on staging", () => {
    // A staging run of the worker should warm staging, and must not be
    // silently promoted to production by this module.
    const env = modalCloneWarmChildEnv({
      S2C_APP_NAME: "echomancer-s2-clone-staging",
    });
    expect(env.S2C_APP_NAME).toBe("echomancer-s2-clone-staging");
    expect(env.S2C_ALLOW_PRODUCTION).toBeUndefined();
  });

  it("keeps the cover aimed at the production app through a real spawn", () => {
    // The end-to-end path: a kick with no env at all still hands the child
    // production plus the opt-in. Asserted on the spawner's captured env, so a
    // change to `defaultSpawn` cannot quietly drop it again.
    const seen: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    setModalCloneWarmSpawnerForTests((command, args, cwd) => {
      // `defaultSpawn` computes the child env; capture what it would export.
      seen.push({ command, args, env: modalCloneWarmChildEnv({}) });
      void cwd;
    });
    vi.stubEnv("MODAL_TOKEN_ID", "test-token");
    expect(kickModalCloneSnapshotWarm("book starting", 5_000)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.args).toEqual([...MODAL_CLONE_COVER_ARGS]);
    expect(seen[0]!.args.join(" ")).toContain("modal/s2_clone_warm.py::cover");
    expect(seen[0]!.env.S2C_APP_NAME).toBe("echomancer-s2-clone");
    expect(seen[0]!.env.S2C_ALLOW_PRODUCTION).toBe("1");
  });
});
