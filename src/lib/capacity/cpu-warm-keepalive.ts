/**
 * Keep one CPU container warm for the New Book hold after a short scaledown.
 *
 * `echomancer-cpu` idles for `CPU_SCALEDOWN_SECONDS` (default 45). A single
 * warm POST would then die in under a minute. The create flow's hold is
 * still five minutes (`WARM_HOLD_MS`): this schedules the extra POSTs that
 * land before the idle window closes, and the last one is early enough that
 * the container is gone at the end of the hold instead of a full window later.
 *
 * The loop starts only when the worker process has `CPU_SCALEDOWN_SECONDS`
 * set below that hold. An unset variable means this process has not been
 * told the deployed window, and a keepalive against a 300s deploy would
 * hold the container past five minutes.
 */

import { WARM_HOLD_MS } from "@/lib/capacity/warm";

export const CPU_SCALEDOWN_DEFAULT_S = 45;
export const CPU_WARM_HOLD_MS = WARM_HOLD_MS;

export function cpuScaledownSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CPU_SCALEDOWN_SECONDS);
  const n = Number.isFinite(raw) ? Math.floor(raw) : CPU_SCALEDOWN_DEFAULT_S;
  return Math.max(2, Math.min(1200, n));
}

/** True only when this process was told the deployed window is shorter than the hold. */
export function cpuWarmKeepaliveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CPU_SCALEDOWN_SECONDS?.trim();
  if (!raw) return false;
  return cpuScaledownSeconds(env) * 1000 < CPU_WARM_HOLD_MS;
}

/**
 * Delays, from the first warm POST, of the follow-up POSTs.
 *
 * Each gap is under the scaledown window. The last delay is
 * `hold − scaledown`, so the container's idle clock runs out as the hold ends.
 */
export function cpuWarmKeepaliveDelays(
  holdMs = CPU_WARM_HOLD_MS,
  scaledownS = CPU_SCALEDOWN_DEFAULT_S
): number[] {
  const scaledownMs = Math.max(2_000, Math.floor(scaledownS) * 1000);
  if (!(holdMs > scaledownMs)) return [];
  const interval = Math.max(5_000, Math.min(scaledownMs - 5_000, Math.floor(scaledownMs / 2)));
  const last = holdMs - scaledownMs;
  const delays: number[] = [];
  for (let t = interval; t < last; t += interval) delays.push(t);
  delays.push(last);
  return delays;
}

let running = false;
let holdUntil = 0;
const timers = new Set<ReturnType<typeof setTimeout>>();

/**
 * Refresh the warm container until the hold ends. A second call inside the
 * hold does not extend it and does not start a second loop.
 */
export function startCpuWarmKeepalive(
  post: () => Promise<unknown>,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now()
): boolean {
  if (!cpuWarmKeepaliveEnabled(env)) return false;
  if (running && now < holdUntil) return false;
  const delays = cpuWarmKeepaliveDelays(CPU_WARM_HOLD_MS, cpuScaledownSeconds(env));
  if (delays.length === 0) return false;
  running = true;
  holdUntil = now + CPU_WARM_HOLD_MS;
  const started = now;
  void (async () => {
    try {
      for (const delay of delays) {
        const wait = started + delay - Date.now();
        if (wait > 0) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, wait);
            timers.add(timer);
          });
        }
        if (Date.now() >= holdUntil) break;
        await post().catch(() => undefined);
      }
    } finally {
      running = false;
    }
  })();
  return true;
}

/** Test seam. Production never calls this. */
export function resetCpuWarmKeepalive(): void {
  running = false;
  holdUntil = 0;
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
}
