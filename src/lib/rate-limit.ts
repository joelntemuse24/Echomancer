// Turso-backed rate limiter — works in serverless (each Vercel function
// instance shares the same DB, unlike in-memory Maps).

import { execute, queryOne } from "@/lib/turso";

let tableEnsured = false;

async function ensureTable() {
  if (tableEnsured) return;
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
  } catch {
    // DB unavailable — fail open. Don't set tableEnsured so we retry next time.
  }
}

export function createRateLimiter(max: number, windowMs: number) {
  const key = `${max}:${windowMs}`;

  return async function checkRateLimit(identifier: string): Promise<boolean> {
    try {
      await ensureTable();
      const now = Date.now();
      const windowStart = Math.floor(now / windowMs) * windowMs;
      const rowKey = `${key}:${windowStart}`;

      // H4: Atomic upsert + read via RETURNING (eliminates race between separate INSERT and SELECT)
      const row = await queryOne<{ count: number }>(
        `INSERT INTO rate_limits (key, identifier, count, window_start)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(key, identifier) DO UPDATE SET count = count + 1
         RETURNING count`,
        [rowKey, identifier, windowStart]
      );

      const allowed = (row?.count ?? 1) <= max;

      // Opportunistic cleanup: delete expired rows older than 2 windows
      if (Math.random() < 0.05) {
        const cutoff = now - windowMs * 2;
        await execute(
          `DELETE FROM rate_limits WHERE window_start < ?`,
          [cutoff]
        ).catch(() => {});
      }

      return allowed;
    } catch {
      // DB unavailable — fail open (allow the request)
      return true;
    }
  };
}
