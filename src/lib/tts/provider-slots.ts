/**
 * Cross-process provider capacity.
 *
 * One worker's in-memory gate does not see another worker. These rows are
 * the shared cap for Fish account calls, Edge section starts, and Modal
 * clone lanes. Slot ids are `0 .. cap-1`, so the table cannot grow with
 * traffic. There is no sweeper: a slot is taken only by inserting it or by
 * an upsert whose previous `expires_at` is already due. Release and renew
 * both require the owner token, so a stale worker cannot clear a successor's
 * slot. Renewal rides the take-home lease heartbeat. A process only reads
 * the table again while it is waiting because the cap is full, and then at
 * most once a second.
 */

import { execute, queryOne } from "@/lib/turso";
import { currentTakehomeLease } from "@/lib/tts/takehome-lease-context";

export const PROVIDER_SLOT_PROVIDERS = ["fish", "edge", "modal-clone"] as const;
export type ProviderSlotName = (typeof PROVIDER_SLOT_PROVIDERS)[number];

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS provider_slots (
  provider TEXT NOT NULL,
  slot_id INTEGER NOT NULL,
  owner_token TEXT NOT NULL,
  job_id TEXT,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (provider, slot_id)
)`;

let tableReady = false;

export interface SlotSql {
  execute(
    sql: string,
    args?: (string | number | null)[]
  ): Promise<{ rowsAffected: number }>;
  queryOne<T>(sql: string, args?: (string | number | null)[]): Promise<T | null>;
}

const appSql: SlotSql = {
  execute: (sql, args) => execute(sql, args),
  queryOne: (sql, args) => queryOne(sql, args),
};

export async function ensureProviderSlotTable(db: SlotSql = appSql): Promise<void> {
  if (db === appSql && tableReady) return;
  await db.execute(CREATE_SQL);
  if (db === appSql) tableReady = true;
}

/** Test seam. */
export function resetProviderSlotTableCache(): void {
  tableReady = false;
}

function clampCap(cap: number): number {
  if (!Number.isFinite(cap) || cap < 1) return 1;
  return Math.min(32, Math.floor(cap));
}

function clampTtl(ttlSeconds: number): number {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds < 5) return 5;
  return Math.min(600, Math.floor(ttlSeconds));
}

/**
 * Take one slot, or return null when every slot is still owned and unexpired.
 * Trying our own live slot again does not count: each caller must land on a
 * distinct slot id, or two sections would share one permit.
 */
export async function tryAcquireProviderSlot(
  db: SlotSql,
  opts: {
    provider: string;
    cap: number;
    ownerToken: string;
    jobId?: string | null;
    ttlSeconds: number;
  }
): Promise<number | null> {
  await ensureProviderSlotTable(db);
  const cap = clampCap(opts.cap);
  const ttl = clampTtl(opts.ttlSeconds);
  for (let slot = 0; slot < cap; slot++) {
    const result = await db.execute(
      `INSERT INTO provider_slots (provider, slot_id, owner_token, job_id, expires_at)
       VALUES (?, ?, ?, ?, unixepoch() + ?)
       ON CONFLICT (provider, slot_id) DO UPDATE SET
         owner_token = excluded.owner_token,
         job_id = excluded.job_id,
         expires_at = excluded.expires_at
       WHERE provider_slots.expires_at <= unixepoch()`,
      [opts.provider, slot, opts.ownerToken, opts.jobId ?? null, ttl]
    );
    if (result.rowsAffected > 0) return slot;
  }
  return null;
}

export async function releaseProviderSlot(
  db: SlotSql,
  opts: { provider: string; slotId: number; ownerToken: string }
): Promise<boolean> {
  const result = await db.execute(
    `DELETE FROM provider_slots
     WHERE provider = ? AND slot_id = ? AND owner_token = ?`,
    [opts.provider, opts.slotId, opts.ownerToken]
  );
  return result.rowsAffected > 0;
}

/** Extend every unexpired slot this token still owns. Returns how many moved. */
export async function renewProviderSlots(
  db: SlotSql,
  opts: { ownerToken: string; ttlSeconds: number }
): Promise<number> {
  await ensureProviderSlotTable(db);
  const result = await db.execute(
    `UPDATE provider_slots
     SET expires_at = unixepoch() + ?
     WHERE owner_token = ? AND expires_at > unixepoch()`,
    [clampTtl(opts.ttlSeconds), opts.ownerToken]
  );
  return result.rowsAffected;
}

/** Milliseconds until the soonest live slot of this provider expires. */
export async function providerSlotWaitMs(
  db: SlotSql,
  provider: string
): Promise<number> {
  const row = await db.queryOne<{ t: number | null }>(
    `SELECT MIN(expires_at) AS t FROM provider_slots
     WHERE provider = ? AND expires_at > unixepoch()`,
    [provider]
  );
  if (row?.t == null) return 200;
  const ms = row.t * 1000 - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 200;
  return Math.min(1000, ms);
}

export interface HeldProviderSlot {
  slotId: number;
  release: () => Promise<void>;
}

/**
 * Acquire a slot, sleeping only while the cap is full.
 * `maxWaitMs` 0 tries once. The sleep is capped at one second so a release
 * is noticed without a background poller.
 */
export async function holdProviderSlot(
  opts: {
    provider: string;
    cap: number;
    ownerToken: string;
    jobId?: string | null;
    ttlSeconds: number;
    maxWaitMs: number;
  },
  db: SlotSql = appSql,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms))
): Promise<HeldProviderSlot | null> {
  const deadline = Date.now() + Math.max(0, opts.maxWaitMs);
  for (;;) {
    const slotId = await tryAcquireProviderSlot(db, opts);
    if (slotId !== null) {
      let released = false;
      return {
        slotId,
        release: async () => {
          if (released) return;
          released = true;
          await releaseProviderSlot(db, {
            provider: opts.provider,
            slotId,
            ownerToken: opts.ownerToken,
          }).catch(() => false);
        },
      };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const wait = Math.min(await providerSlotWaitMs(db, opts.provider), remaining);
    await sleep(wait);
  }
}

/**
 * The shared cap is full. The book is deferred, not failed. Callers try
 * once: sleeping here would poll the table, and the drain interval is the
 * retry.
 */
export class ProviderSlotBusyError extends Error {
  constructor(provider: string) {
    super(`${provider} capacity is in use`);
    this.name = "ProviderSlotBusyError";
  }
}

export async function holdFishTakehomeSlot(cap: number): Promise<HeldProviderSlot> {
  const lease = currentTakehomeLease();
  const held = await holdProviderSlot({
    provider: "fish",
    cap,
    ownerToken: lease?.token ?? `fish_${crypto.randomUUID()}`,
    jobId: lease?.jobId ?? null,
    ttlSeconds: 90,
    maxWaitMs: 0,
  });
  if (!held) throw new ProviderSlotBusyError("fish");
  return held;
}

export async function holdEdgeSectionSlot(cap: number): Promise<HeldProviderSlot> {
  const lease = currentTakehomeLease();
  const held = await holdProviderSlot({
    provider: "edge",
    cap,
    ownerToken: lease?.token ?? `edge_${crypto.randomUUID()}`,
    jobId: lease?.jobId ?? null,
    ttlSeconds: 90,
    maxWaitMs: 0,
  });
  if (!held) throw new ProviderSlotBusyError("edge");
  return held;
}

/**
 * One Modal lane. Does not wait: burning the cold-start budget on a full
 * pool would look like a restore. The caller treats null as lane-busy and
 * leaves the section unclaimed.
 */
export async function holdModalCloneLaneSlot(
  cap: number
): Promise<HeldProviderSlot | null> {
  const lease = currentTakehomeLease();
  return holdProviderSlot({
    provider: "modal-clone",
    cap,
    ownerToken: lease?.token ?? `modal_${crypto.randomUUID()}`,
    jobId: lease?.jobId ?? null,
    ttlSeconds: 90,
    maxWaitMs: 0,
  });
}

/** Heartbeat hook. A lost lease simply renews zero rows. */
export async function renewTakehomeProviderSlots(
  ownerToken: string,
  ttlSeconds: number
): Promise<number> {
  return renewProviderSlots(appSql, { ownerToken, ttlSeconds });
}
