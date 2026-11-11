/**
 * Off-path GPU snapshot warm.
 *
 * A book talks to Modal over HTTP. The proxy drops that connection at ~542 s,
 * which is mid-compile, so the snapshot never sticks and the next placement
 * compiles again. This module starts `modal run …::cover` — client RPC, no
 * proxy limit — and does not wait for it. The book has already moved on.
 *
 * Two callers, and they want different things:
 *
 * - **A cold placement** (`prewarm: false`). The 150 s budget was spent, so a
 *   compile may be in progress. This one is allowed to sit through it, because
 *   the book has already parked.
 * - **A book that is about to need a GPU** (`prewarm: true`). A book-start
 *   call passes `jobId`. That book's restore starts even when another book
 *   prewarmed seconds ago, and it still refuses when `modal_gpu_leases` is
 *   already at `MODAL_S2_MAX_GPUS` or that user's cap. Voice-list and extract
 *   prewarms pass no job id and stay on the shared 3-minute clock, so they
 *   do not stack a second container on one that just started.
 *
 * A compile kick stays one per process. A compile is 8–16 min; stacking them
 * is how the October run spent a fleet of H100s on the same cold boot.
 */
import { spawn } from "node:child_process";
import {
  modalCloneMaxGpus,
  modalCloneMaxGpusPerUser,
} from "@/lib/tts/providers/modal-gpu-lease";

/** Long enough that a second book does not start a second compile. */
export const MODAL_CLONE_WARM_COOLDOWN_MS = 20 * 60_000;

/**
 * A pre-warm is only useful for the gap between "a book is starting" and "its
 * first Modal call". A restore is ~1 min, so a pre-warm older than this has
 * already either restored (and a fresh call will hit it) or is compiling (and
 * cooldown is the right answer). Shorter than the compile cooldown on purpose:
 * this path is cheap and idempotent, and a book must not be blocked by a
 * pre-warm that already did its job.
 */
export const MODAL_CLONE_PREWARM_COOLDOWN_MS = 3 * 60_000;

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
let nextPreWarmAt = 0;
/** Book-start restores. A second book is not swallowed by the first. */
const prewarmAtByJob = new Map<string, number>();
let loggedUnconfigured = false;

export type ModalClonePrewarmOptions = {
  jobId?: string;
  userId?: string;
  /**
   * Live `modal_gpu_leases` rows. Omitted (a ledger the worker could not
   * read, or a unit test of the clock) skips the cap. Passed and already
   * at the ceiling, the kick does not start another restore.
   */
  leases?: ReadonlyArray<{ jobId: string; userId: string }>;
};

export function resetModalCloneWarmForTests(): void {
  nextKickAt = 0;
  nextPreWarmAt = 0;
  prewarmAtByJob.clear();
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
  return startWarm(reason, now, "kick");
}

/**
 * Start the restore **before** the book needs it.
 *
 * Called when a file starts being read for someone who already has a trained
 * clone, when that person's voice list is built, and again at the top of a
 * clone tick. The point is overlap: a restore is ~1 min, so a container that
 * starts restoring while the file is read or the voice is chosen is often
 * already warm by the time section 0 is sent. A restore that is still in
 * progress does not join that HTTP call — Modal places a second container —
 * so this only removes the restore when it finishes first. The tick-start
 * call still covers a book whose prewarm missed, overlapping packing and the
 * reference download with whatever restore is left.
 *
 * It is deliberately cheap and idempotent: one RPC `status()` per cooldown, no
 * wait, and no GPU left running afterwards (the app is `min_containers=0`, so
 * the container still scales to zero when idle). It cannot compile on the book
 * path — it is a separate RPC that the book never awaits — so #237 holds.
 */
export function prewarmModalCloneSnapshot(
  reason: string,
  now = Date.now(),
  opts?: ModalClonePrewarmOptions
): boolean {
  return startWarm(reason, now, "prewarm", opts);
}

/**
 * A book-start restore still has to fit under the GPU ceiling. The lease
 * rows are the shared count across workers. No rows means the caller did
 * not ask for the check.
 */
function prewarmWithinGpuCap(opts: ModalClonePrewarmOptions): boolean {
  if (!opts.leases) return true;
  if (opts.leases.length >= modalCloneMaxGpus()) return false;
  if (opts.userId) {
    const used = opts.leases.filter((row) => row.userId === opts.userId).length;
    if (used >= modalCloneMaxGpusPerUser()) return false;
  }
  return true;
}

function startWarm(
  reason: string,
  now: number,
  kind: "kick" | "prewarm",
  opts?: ModalClonePrewarmOptions
): boolean {
  if (process.env.MODAL_S2_WARM_HOOK === "0") return false;
  const jobId = kind === "prewarm" ? opts?.jobId : undefined;
  const cooldown =
    kind === "prewarm"
      ? MODAL_CLONE_PREWARM_COOLDOWN_MS
      : MODAL_CLONE_WARM_COOLDOWN_MS;
  if (jobId) {
    // This book's own clock. Another book's prewarm, and the compile
    // kick's clock, do not hold it. The GPU cap is the bound.
    if (now < (prewarmAtByJob.get(jobId) ?? 0)) return false;
    if (opts && !prewarmWithinGpuCap(opts)) {
      console.log(`[modal-clone] pre-warm skipped (${reason}): GPU cap`);
      return false;
    }
  } else if (now < (kind === "prewarm" ? nextPreWarmAt : nextKickAt)) {
    // Voice-list and extract prewarms share one clock. A compile kick
    // claims that clock too, so those prewarms do not stack on it. A kick
    // reads only its own clock, so a recent prewarm does not cancel it.
    return false;
  }
  if (!modalCloneWarmConfigured()) {
    if (!loggedUnconfigured) {
      loggedUnconfigured = true;
      console.warn(
        "[modal-clone] snapshot warm not started: set MODAL_TOKEN_ID on the worker (or MODAL_S2_WARM_CMD). Books do not build snapshots."
      );
    }
    return false;
  }
  // Claim the cooldown before spawn so a repeat of this same kick shares
  // one RPC. A job-scoped prewarm also moves the shared clock, so the
  // voice list does not stack a container on a book that just started.
  // It does not move the compile clock, and it does not block another book.
  if (jobId) {
    prewarmAtByJob.set(jobId, now + MODAL_CLONE_PREWARM_COOLDOWN_MS);
    if (prewarmAtByJob.size > 4_000) {
      const oldest = prewarmAtByJob.keys().next().value;
      if (oldest) prewarmAtByJob.delete(oldest);
    }
    nextPreWarmAt = Math.max(
      nextPreWarmAt,
      now + MODAL_CLONE_PREWARM_COOLDOWN_MS
    );
  } else {
    nextPreWarmAt = now + Math.max(cooldown, MODAL_CLONE_PREWARM_COOLDOWN_MS);
    if (kind === "kick") nextKickAt = now + MODAL_CLONE_WARM_COOLDOWN_MS;
  }
  const cwd = process.env.MODAL_S2_WARM_CWD?.trim() || process.cwd();
  try {
    const custom = process.env.MODAL_S2_WARM_CMD?.trim();
    if (custom) spawner(custom, [], cwd);
    else spawner("modal", [...MODAL_CLONE_COVER_ARGS], cwd);
    console.log(
      `[modal-clone] ${kind === "prewarm" ? "pre-warm" : "off-path snapshot warm"} started (${reason})`
    );
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
