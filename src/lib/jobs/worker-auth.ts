/**
 * Authorisation for the two routes that are allowed to spend money on
 * synthesis. Both are machine-only: no browser session can reach them.
 *
 * Missing secrets are rejected in production rather than waved through — an
 * unauthenticated worker endpoint is an open invitation to burn the OpenRouter
 * balance. Locally, where no secret is configured, they stay reachable so the
 * pipeline can be exercised without extra setup.
 */

import type { NextRequest } from "next/server";

function isDeployed(): boolean {
  return process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** `POST /api/jobs/[id]/process` — guarded by `INTERNAL_JOB_SECRET`. */
export function authorizeInternalWorker(request: NextRequest): boolean {
  const secret = process.env.INTERNAL_JOB_SECRET?.trim();
  if (!secret) {
    if (isDeployed()) {
      console.error("[worker] INTERNAL_JOB_SECRET is not set — rejecting");
      return false;
    }
    return true;
  }
  const provided = request.headers.get("x-internal-secret") || "";
  return timingSafeEqual(provided, secret);
}

/**
 * `GET /api/cron/process-jobs`. Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET`; `INTERNAL_JOB_SECRET` is accepted too so
 * an operator can trigger a drain by hand with the secret they already have.
 */
export function authorizeCron(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  const internalSecret = process.env.INTERNAL_JOB_SECRET?.trim();

  if (!cronSecret && !internalSecret) {
    if (isDeployed()) {
      console.error("[cron] CRON_SECRET is not set — rejecting");
      return false;
    }
    return true;
  }

  const bearer = request.headers.get("authorization") || "";
  if (cronSecret && timingSafeEqual(bearer, `Bearer ${cronSecret}`)) return true;

  const header = request.headers.get("x-internal-secret") || "";
  return Boolean(internalSecret) && timingSafeEqual(header, internalSecret!);
}
