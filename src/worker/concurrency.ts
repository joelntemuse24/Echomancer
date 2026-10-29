/**
 * Whole-book worker slots. Each slot runs one wave, so extra slots multiply
 * provider rate limits and the memory a single box must hold. Default 1;
 * raising it is a deliberate deployment choice (see WORKER.md).
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
