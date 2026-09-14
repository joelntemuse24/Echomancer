/**
 * Bearer (or x-worker-secret / x-internal-secret) check for the VM worker.
 */

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function workerSharedSecret(): string | undefined {
  return (
    process.env.WORKER_SECRET?.trim() ||
    process.env.TAKEHOME_WORKER_SECRET?.trim() ||
    process.env.INTERNAL_JOB_SECRET?.trim() ||
    undefined
  );
}

export function authorizeWorkerRequest(headers: {
  authorization?: string | undefined;
  workerSecret?: string | undefined;
  internalSecret?: string | undefined;
}): boolean {
  const secret = workerSharedSecret();
  if (!secret) return false;

  const bearer = headers.authorization || "";
  if (timingSafeEqual(bearer, `Bearer ${secret}`)) return true;

  const header = headers.workerSecret || headers.internalSecret || "";
  return timingSafeEqual(header, secret);
}
