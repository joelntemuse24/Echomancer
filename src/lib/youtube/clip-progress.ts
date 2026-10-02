/**
 * Quiet fill for the server clip wait. It stays under 1 until the voice is ready.
 */

export type ClipWaitPhase = "starting" | "fetching" | "preparing";

export function clipWaitProgress(elapsedMs: number, phase: ClipWaitPhase): number {
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  if (phase === "preparing") {
    return Math.min(0.95, 0.72 + Math.min(1, elapsed / 20_000) * 0.23);
  }
  if (phase === "starting") {
    return Math.min(0.12, (elapsed / 4_000) * 0.12);
  }
  return Math.min(0.7, (elapsed / 40_000) * 0.7);
}

export function clipPhaseFromStatus(
  status: string | null | undefined,
  phase: string | null | undefined
): ClipWaitPhase {
  if (phase === "preparing") return "preparing";
  if (!status || status === "queued") return "starting";
  return "fetching";
}
