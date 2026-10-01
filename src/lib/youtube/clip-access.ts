/**
 * The proxied clip path is on only for an allowlisted verified email, and
 * only while the worker reports that PROXY_URL is set. The URL itself stays
 * on the worker.
 */

import { queryOne } from "@/lib/turso";
import { takehomeWorkerUrl } from "@/lib/jobs/takehome-worker-client";
import { proxyClipEmailAllowed } from "@/lib/youtube/clip-policy";

let workerCache: { at: number; ok: boolean } | null = null;

export function resetClipProxyCache(): void {
  workerCache = null;
}

export async function workerHasClipProxy(): Promise<boolean> {
  if (workerCache && Date.now() - workerCache.at < 30_000) return workerCache.ok;
  const base = takehomeWorkerUrl();
  if (!base) {
    workerCache = { at: Date.now(), ok: false };
    return false;
  }
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) });
    const body = (await response.json()) as { clipProxy?: boolean };
    const ok = response.ok && body.clipProxy === true;
    workerCache = { at: Date.now(), ok };
    return ok;
  } catch {
    workerCache = { at: Date.now(), ok: false };
    return false;
  }
}

export async function proxyClipsEnabled(userId: string): Promise<boolean> {
  const row = await queryOne<{ email: string | null; email_verified: number | null }>(
    `SELECT email, email_verified FROM users WHERE id = ? LIMIT 1`,
    [userId]
  );
  if (!row || Number(row.email_verified) !== 1) return false;
  if (!proxyClipEmailAllowed(row.email)) return false;
  return workerHasClipProxy();
}
