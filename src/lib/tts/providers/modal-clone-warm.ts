/**
 * Off-path GPU snapshot warm.
 *
 * A book talks to Modal over HTTP. The proxy drops that connection at ~542 s,
 * which is mid-compile, so the snapshot never sticks and the next placement
 * compiles again. This module starts `modal run …::cover` — client RPC, no
 * proxy limit — and does not wait for it. The book has already moved on.
 *
 * One kick at a time. A compile is 8–16 min; stacking them is how the October
 * run spent a fleet of H100s on the same cold boot.
 */
import { spawn } from "node:child_process";

/** Long enough that a second book does not start a second compile. */
export const MODAL_CLONE_WARM_COOLDOWN_MS = 20 * 60_000;

/**
 * One RPC `status()` call. It may compile. Rounds and scale-to-zero coverage
 * belong to an operator running `cover` directly, not to a customer book.
 */
export const MODAL_CLONE_COVER_ARGS = [
  "run",
  "modal/s2_clone_warm.py::cover",
  "--containers",
  "1",
  "--rounds",
  "1",
  "--streak",
  "1",
  "--scaledown",
  "0",
] as const;

type Spawner = (command: string, args: string[], cwd: string) => void;

let spawner: Spawner = defaultSpawn;
let nextKickAt = 0;
let loggedUnconfigured = false;

export function resetModalCloneWarmForTests(): void {
  nextKickAt = 0;
  loggedUnconfigured = false;
  spawner = defaultSpawn;
}

export function setModalCloneWarmSpawnerForTests(fn: Spawner | null): void {
  spawner = fn ?? defaultSpawn;
}

/** True when this process is allowed to start the RPC. */
export function modalCloneWarmConfigured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (env.MODAL_S2_WARM_HOOK === "0") return false;
  if (env.MODAL_S2_WARM_CMD?.trim()) return true;
  return Boolean(env.MODAL_TOKEN_ID?.trim() || env.MODAL_TOKEN_SECRET?.trim());
}

/**
 * Start a snapshot compile/restore off the book path.
 *
 * Returns false when the hook is disabled, still inside the cooldown, or this
 * process has no Modal credentials. Never throws: a book must not fail because
 * the warm could not be started.
 */
export function kickModalCloneSnapshotWarm(reason: string, now = Date.now()): boolean {
  if (process.env.MODAL_S2_WARM_HOOK === "0") return false;
  if (now < nextKickAt) return false;
  if (!modalCloneWarmConfigured()) {
    if (!loggedUnconfigured) {
      loggedUnconfigured = true;
      console.warn(
        "[modal-clone] snapshot warm not started: set MODAL_TOKEN_ID on the worker (or MODAL_S2_WARM_CMD). Books do not build snapshots."
      );
    }
    return false;
  }
  // Claim the cooldown before spawn so parallel lanes share one RPC.
  nextKickAt = now + MODAL_CLONE_WARM_COOLDOWN_MS;
  const cwd = process.env.MODAL_S2_WARM_CWD?.trim() || process.cwd();
  try {
    const custom = process.env.MODAL_S2_WARM_CMD?.trim();
    if (custom) spawner(custom, [], cwd);
    else spawner("modal", [...MODAL_CLONE_COVER_ARGS], cwd);
    console.log(`[modal-clone] off-path snapshot warm started (${reason})`);
    return true;
  } catch (err) {
    console.warn(
      "[modal-clone] snapshot warm failed to start:",
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

function defaultSpawn(command: string, args: string[], cwd: string): void {
  const env = {
    ...process.env,
    S2C_APP_NAME:
      process.env.S2C_APP_NAME?.trim() ||
      process.env.MODAL_S2_APP_NAME?.trim() ||
      "echomancer-s2-clone",
  };
  const child =
    args.length === 0
      ? spawn(command, { cwd, env, detached: true, stdio: "ignore", shell: true })
      : spawn(command, args, { cwd, env, detached: true, stdio: "ignore" });
  child.once("error", (err) => {
    console.warn("[modal-clone] snapshot warm process:", err.message);
  });
  child.unref();
}
