/**
 * Turso-backed rate limiter.
 *
 * Counters live in the database rather than an in-memory Map because every
 * Vercel invocation is a fresh isolate — an in-process counter would reset
 * constantly and enforce nothing.
 *
 * Failure policy is explicit per limiter. Cheap endpoints keep failing **open**
 * so a database blip does not take the whole app down, but anything that spends
 * money upstream (synthesis, uploads, catalog fan-out) fails **closed**: if we
 * cannot count the request, we do not serve it.
 */

import { execute, queryOne } from "@/lib/turso";

let tableEnsured = false;

async function ensureTable(): Promise<boolean> {
  if (tableEnsured) return true;
  try {
    await execute(
      `CREATE TABLE IF NOT EXISTS rate_limits (
        key TEXT NOT NULL,
        identifier TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        window_start INTEGER NOT NULL,
        PRIMARY KEY (key, identifier)
      )`
    );
    tableEnsured = true;
    return true;
  } catch {
    return false;
  }
}

export interface RateLimitOptions {
  /**
   * What to do when the counter itself is unavailable.
   * `"closed"` (default for costly routes) rejects the request.
   */
  onError?: "open" | "closed";
}

export function createRateLimiter(
  max: number,
  windowMs: number,
  options?: RateLimitOptions
) {
  const key = `${max}:${windowMs}`;
  const failClosed = options?.onError === "closed";

  return async function checkRateLimit(identifier: string): Promise<boolean> {
    try {
      if (!(await ensureTable())) return !failClosed;

      const now = Date.now();
      const windowStart = Math.floor(now / windowMs) * windowMs;
      const rowKey = `${key}:${windowStart}`;

      // Upsert and read in one statement: a separate INSERT + SELECT lets two
      // concurrent requests both observe the pre-increment count.
      const row = await queryOne<{ count: number }>(
        `INSERT INTO rate_limits (key, identifier, count, window_start)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(key, identifier) DO UPDATE SET count = count + 1
         RETURNING count`,
        [rowKey, identifier, windowStart]
      );

      if (row?.count == null) return !failClosed;

      const allowed = row.count <= max;

      if (Math.random() < 0.05) {
        const cutoff = now - windowMs * 2;
        await execute(`DELETE FROM rate_limits WHERE window_start < ?`, [
          cutoff,
        ]).catch(() => {});
      }

      return allowed;
    } catch {
      return !failClosed;
    }
  };
}

/** Test seam: forget that the counter table was already created. */
export function resetRateLimitTableCache(): void {
  tableEnsured = false;
}

/**
 * Stable limiter identity for a request.
 *
 * Sessions are preferred over IPs: an IP is shared by everyone behind a NAT and
 * is trivially rotated by an abuser, while a session is server-issued. Raw IPs
 * are hashed so limiter rows are not a log of who visited.
 */
export async function rateLimitIdentity(opts: {
  userId?: string | null;
  ip?: string | null;
}): Promise<string> {
  if (opts.userId) return `u:${opts.userId}`;
  if (!opts.ip) return "ip:unknown";
  return `ip:${await hashIdentifier(opts.ip)}`;
}

async function hashIdentifier(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest).slice(0, 10))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function clientIp(request: {
  headers: { get(name: string): string | null };
}): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || request.headers.get("x-real-ip") || null;
}
