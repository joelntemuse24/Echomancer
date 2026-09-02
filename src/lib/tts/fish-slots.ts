/**
 * Fish Starter allows 5 concurrent requests account-wide. Live Listen /
 * Live Stream on Vercel share FISH_API_KEY with Trigger take-home, so
 * Whole book defaults to 4 and only uses 5 when no live request is in flight.
 */

import { execute, queryOne } from "@/lib/turso";

export const FISH_ACCOUNT_CONCURRENCY = 5;
export const DEFAULT_TAKEHOME_FANOUT = 4;

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS fish_inflight (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  expires_at INTEGER NOT NULL
)`;

let tableReady = false;

async function ensureTable(): Promise<void> {
  if (tableReady) return;
  try {
    await execute(CREATE_SQL);
    tableReady = true;
  } catch (err) {
    console.warn(
      "[fish-slots] table create failed:",
      err instanceof Error ? err.message : err
    );
  }
}

export function resetFishSlotTableCache(): void {
  tableReady = false;
}

/** Live Fish HTTP streams (preview / listen) hold a slot until they end. */
export async function beginLiveFish(): Promise<() => Promise<void>> {
  const id = `live_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  try {
    await ensureTable();
    await execute(
      `INSERT INTO fish_inflight (id, kind, expires_at)
       VALUES (?, 'live', unixepoch() + 120)`,
      [id]
    );
  } catch (err) {
    console.warn(
      "[fish-slots] begin live failed:",
      err instanceof Error ? err.message : err
    );
  }

  let ended = false;
  return async () => {
    if (ended) return;
    ended = true;
    try {
      await execute(`DELETE FROM fish_inflight WHERE id = ?`, [id]);
    } catch {
      /* ignore */
    }
  };
}

export async function countLiveFishInflight(): Promise<number> {
  try {
    await ensureTable();
    await execute(
      `DELETE FROM fish_inflight WHERE expires_at <= unixepoch()`
    ).catch(() => {});
    const row = await queryOne<{ n: number }>(
      `SELECT COUNT(*) as n FROM fish_inflight
       WHERE kind = 'live' AND expires_at > unixepoch()`
    );
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Take-home fan-out: 4 when live traffic is sharing the key, 5 when idle.
 * Never above 5. `TTS_TAKEHOME_FANOUT` can pin a lower cap.
 */
export async function takehomeFanoutCap(): Promise<number> {
  const pinned = Number(process.env.TTS_TAKEHOME_FANOUT);
  if (Number.isFinite(pinned) && pinned > 0) {
    return Math.max(1, Math.min(FISH_ACCOUNT_CONCURRENCY, Math.floor(pinned)));
  }
  const live = await countLiveFishInflight();
  return live > 0 ? DEFAULT_TAKEHOME_FANOUT : FISH_ACCOUNT_CONCURRENCY;
}

let inProcess = 0;
const waiters: Array<() => void> = [];

/**
 * In-process gate so one Trigger worker never opens a sixth Fish call.
 */
export async function withFishSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (inProcess >= FISH_ACCOUNT_CONCURRENCY) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  inProcess += 1;
  try {
    return await fn();
  } finally {
    inProcess -= 1;
    const next = waiters.shift();
    if (next) next();
  }
}

/** Test seam. */
export function resetFishSlotProcessGate(): void {
  inProcess = 0;
  waiters.length = 0;
}
