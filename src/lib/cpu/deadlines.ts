/**
 * CPU time budgets.
 *
 * The orchestrator only waits for the container to accept. The container's
 * own deadline is longer, and concat is longer than a section. A placement
 * lease covers cold start until the child heartbeats. None of these is a
 * dollar cap: `CPU_MAX_CONTAINERS` is how many containers may exist.
 */

function clamp(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** How long the orchestrator waits for an HTTP accept. Not the task budget. */
export function cpuDispatchAcceptMs(
  env: Record<string, string | undefined> = process.env
): number {
  return clamp(env.CPU_DISPATCH_ACCEPT_MS, 20_000, 1_000, 60_000);
}

/** Master, whisper, and extract. The container is killed at this budget. */
export function cpuSectionBudgetSeconds(
  env: Record<string, string | undefined> = process.env
): number {
  return clamp(env.CPU_FUNCTION_TIMEOUT_S, 900, 30, 3_600);
}

/** Final concat. Independent of the section budget. */
export function cpuConcatBudgetSeconds(
  env: Record<string, string | undefined> = process.env
): number {
  return clamp(env.CPU_CONCAT_TIMEOUT_S, 3_600, 60, 21_600);
}

export function cpuWorkBudgetSeconds(
  kind: string,
  env: Record<string, string | undefined> = process.env
): number {
  return kind === "concat" ? cpuConcatBudgetSeconds(env) : cpuSectionBudgetSeconds(env);
}

/**
 * Lease written before the POST. Long enough for a cold container to
 * start and heartbeat. A timed-out caller keeps this lease and does not
 * POST again. After expiry with no heartbeat the task can be reclaimed.
 */
export function cpuPlacementLeaseSeconds(
  env: Record<string, string | undefined> = process.env
): number {
  return clamp(env.CPU_PLACEMENT_LEASE_S, 180, 30, 600);
}

/** How long a book that is only waiting on CPU stays off the drain. */
export function cpuYieldSeconds(
  env: Record<string, string | undefined> = process.env
): number {
  return clamp(env.CPU_YIELD_SEC, 3, 1, 60);
}
