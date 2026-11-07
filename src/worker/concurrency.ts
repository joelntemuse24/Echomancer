/**
 * Whole-book worker slots. Each slot runs one orchestration wave.
 * The raw parser does not decide whether local ffmpeg may stack.
 */
export function workerConcurrencyFromEnv(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env.WORKER_CONCURRENCY;
  if (raw === undefined || raw.trim() === "") return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

/** Orchestrator slots when CPU work is on the Modal fleet, not this host. */
export const DEFAULT_MODAL_ORCHESTRATOR_SLOTS = 8;

/**
 * How many books this process may orchestrate at once.
 *
 * Local CPU (the default) stays at one book unless
 * `WORKER_LOCAL_MULTIBOOK=1`. That flag stacks ffmpeg on this machine
 * and is not a production setting. `CPU_RUNNER=modal` uses
 * `ORCH_CONCURRENCY` (default 8) when `WORKER_CONCURRENCY` is unset,
 * because encodes are not on this host. An explicit `WORKER_CONCURRENCY`
 * still wins in modal mode.
 */
export function effectiveOrchestratorConcurrency(
  env: Record<string, string | undefined> = process.env
): number {
  const modal = env.CPU_RUNNER === "modal";
  const explicit = env.WORKER_CONCURRENCY !== undefined && env.WORKER_CONCURRENCY.trim() !== "";
  if (!modal) {
    const n = workerConcurrencyFromEnv(env);
    if (n > 1 && env.WORKER_LOCAL_MULTIBOOK !== "1") return 1;
    return n;
  }
  if (explicit) return Math.min(64, workerConcurrencyFromEnv(env));
  const raw = Number(env.ORCH_CONCURRENCY ?? DEFAULT_MODAL_ORCHESTRATOR_SLOTS);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_MODAL_ORCHESTRATOR_SLOTS;
  return Math.min(64, Math.floor(raw));
}
