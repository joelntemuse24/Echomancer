/**
 * Cancel the worker's own Modal FunctionCall after a first-light wait aborts.
 *
 * The HTTP `fetch` abort drops the wait. The sync Modal handler would otherwise
 * keep the input, and abandoned PENDING calls pile up — later served after
 * `@modal.enter`, which interrupts snapshot publish. This module fires a
 * best-effort cancel of *unstarted* PENDING inputs only. A call that has
 * already started enter or compile is left alone.
 *
 * Uses the same Modal credentials as the off-path snapshot warm hook
 * (`MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET`). Never throws into the book path.
 * Never passes terminate_containers=True, and never stops a container.
 */
import { spawn } from "node:child_process";

export const MODAL_CLONE_CANCEL_UNSTARTED_ARGS = [
  "scripts/s2/cancel-unstarted-pending.py",
] as const;

type Canceller = (opts: ModalCloneCancelOpts) => boolean;

export type ModalCloneCancelOpts = {
  jobId?: string;
  reason?: string;
};

let canceller: Canceller = defaultCancel;
let loggedUnconfigured = false;

export function resetModalCloneCancelForTests(): void {
  loggedUnconfigured = false;
  // Unit tests must never spawn a real Modal CLI against production.
  canceller = () => false;
}

export function setModalCloneCallCancellerForTests(fn: Canceller | null): void {
  canceller = fn ?? defaultCancel;
}

export function modalCloneCancelConfigured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (env.MODAL_S2_CANCEL_ON_ABORT === "0") return false;
  if (env.MODAL_S2_CANCEL_CMD?.trim()) return true;
  return Boolean(env.MODAL_TOKEN_ID?.trim() || env.MODAL_TOKEN_SECRET?.trim());
}

/**
 * Whether an input may be cancelled after a first-light abort.
 *
 * Only unstarted PENDING leftovers. A started call may be mid-enter or
 * mid-compile; cancelling it interrupts snapshot publish.
 */
export function mayCancelAbandonedModalCall(row: {
  status?: string | null;
  started_at?: string | null;
  container_id?: string | null;
}): boolean {
  const status = String(row.status ?? "")
    .trim()
    .toLowerCase()
    .replace(/^inputstatus\./, "");
  const terminal = new Set([
    "success",
    "failure",
    "terminated",
    "timeout",
    "init_failure",
    "1",
    "2",
    "3",
    "4",
    "5",
  ]);
  if (terminal.has(status)) return false;
  if (row.started_at) return false;
  return status === "pending" || status === "0" || status === "";
}

/**
 * Fire-and-forget cancel of this process's abandoned unstarted Modal inputs.
 *
 * Returns false when the hook is disabled or unconfigured. Never throws.
 */
export function cancelAbandonedModalCallsAfterAbort(
  opts: ModalCloneCancelOpts = {}
): boolean {
  try {
    return canceller(opts);
  } catch (err) {
    console.warn(
      "[modal-clone] abandoned-call cancel failed:",
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

function defaultCancel(opts: ModalCloneCancelOpts): boolean {
  if (!modalCloneCancelConfigured()) {
    if (!loggedUnconfigured) {
      loggedUnconfigured = true;
      console.warn(
        "[modal-clone] first-light abort did not cancel the Modal call: set MODAL_TOKEN_ID on the worker (or MODAL_S2_CANCEL_CMD)"
      );
    }
    return false;
  }
  const cwd = process.env.MODAL_S2_WARM_CWD?.trim() || process.cwd();
  const args: string[] = [...MODAL_CLONE_CANCEL_UNSTARTED_ARGS];
  if (opts.jobId) args.push("--job-id", opts.jobId);
  const custom = process.env.MODAL_S2_CANCEL_CMD?.trim();
  const command = custom || process.env.MODAL_S2_CANCEL_PYTHON?.trim() || "python3";
  const commandArgs = custom ? [] : args;
  const env = {
    ...process.env,
    S2C_APP_NAME:
      process.env.S2C_APP_NAME?.trim() ||
      process.env.MODAL_S2_APP_NAME?.trim() ||
      "echomancer-s2-clone",
  };
  const child =
    commandArgs.length === 0
      ? spawn(command, { cwd, env, detached: true, stdio: "ignore", shell: true })
      : spawn(command, commandArgs, { cwd, env, detached: true, stdio: "ignore" });
  child.once("error", (err) => {
    console.warn("[modal-clone] abandoned-call cancel process:", err.message);
  });
  child.unref();
  console.log(
    `[modal-clone] cancelling unstarted pending Modal call after abort (${opts.reason ?? "first-light wait aborted"})`
  );
  return true;
}

// Vitest must not inherit the production spawner.
if (process.env.VITEST) {
  resetModalCloneCancelForTests();
}
