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
 *
 * A take-home slot's owner token is the lease token, so the lease heartbeat
 * renews it. A live listen, preview, or stream has no lease: the holder
 * renews on its own timer until release. Both renews are one UPDATE for
 * that owner, not a table scan.
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

const CREATE_THROTTLE_SQL = `
CREATE TABLE IF NOT EXISTS provider_throttle (
  provider TEXT PRIMARY KEY,
  cap INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)`;

/** How long an Edge 429 keeps the shared section cap halved. */
export const EDGE_THROTTLE_TTL_SECONDS = 120;

/**
 * Paradee sections in flight, shared by every process. Matches
 * `paradeeFanout`: the sidecar's own two-chunk fan-out stays inside one
 * section permit.
 */
export function paradeeSharedCap(): number {
  const raw = Number(process.env.TTS_PARADEE_FANOUT);
  const chosen = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3;
  return Math.max(1, chosen);
}

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
  await db.execute(CREATE_THROTTLE_SQL);
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
      // A take-home lease heartbeat already renews every slot it owns.
      // Anything else (preview, live, stream) has to renew itself or a
      // 90s TTL expires under a listen that is still speaking.
      const renewTimer = currentTakehomeLease()
        ? null
        : setInterval(() => {
            void renewProviderSlots(db, {
              ownerToken: opts.ownerToken,
              ttlSeconds: opts.ttlSeconds,
            }).catch(() => undefined);
          }, Math.max(5_000, Math.floor(clampTtl(opts.ttlSeconds) * 1000 / 3)));
      renewTimer?.unref?.();
      return {
        slotId,
        release: async () => {
          if (released) return;
          released = true;
          if (renewTimer) clearInterval(renewTimer);
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

export async function holdNamedProviderSlot(
  provider: string,
  cap: number
): Promise<HeldProviderSlot> {
  const lease = currentTakehomeLease();
  const held = await holdProviderSlot({
    provider,
    cap,
    ownerToken: lease?.token ?? `${provider}_${crypto.randomUUID()}`,
    jobId: lease?.jobId ?? null,
    ttlSeconds: 90,
    maxWaitMs: 0,
  });
  if (!held) throw new ProviderSlotBusyError(provider);
  return held;
}

/**
 * Edge section cap after a shared 429. A missing or expired row means the
 * configured cap. A read failure uses the configured cap too: this process
 * still has its own in-memory halving, and a broken throttle row must not
 * stop every book.
 */
export async function edgeEffectiveCap(cap: number): Promise<number> {
  try {
    const shared = await readProviderThrottle("edge");
    if (shared == null) return cap;
    return Math.max(1, Math.min(cap, shared));
  } catch {
    return cap;
  }
}

export async function holdEdgeSectionSlot(cap: number): Promise<HeldProviderSlot> {
  return holdNamedProviderSlot("edge", await edgeEffectiveCap(cap));
}

/**
 * One listen, preview, or live-stream request. Fish holds its own permit
 * inside the Fish HTTP call so a take-home that already took one does not
 * take a second. Returns null for Fish.
 */
export async function holdListenerSlot(
  providerId: string,
  edgeCap: number
): Promise<HeldProviderSlot | null> {
  if (providerId === "fish") return null;
  if (providerId === "edge" || providerId === "google") {
    return holdEdgeSectionSlot(edgeCap);
  }
  if (providerId === "paradee") {
    return holdNamedProviderSlot("paradee", paradeeSharedCap());
  }
  return holdNamedProviderSlot(providerId, 5);
}

/** Remember a halved Edge cap for every process. No poller reads it. */
export async function writeProviderThrottle(
  provider: string,
  cap: number,
  ttlSeconds: number
): Promise<void> {
  await ensureProviderSlotTable();
  const next = Math.max(1, Math.min(32, Math.floor(cap)));
  const ttl = Math.max(5, Math.min(600, Math.floor(ttlSeconds)));
  await execute(
    `INSERT INTO provider_throttle (provider, cap, expires_at)
     VALUES (?, ?, unixepoch() + ?)
     ON CONFLICT(provider) DO UPDATE SET
       cap = excluded.cap,
       expires_at = excluded.expires_at`,
    [provider, next, ttl]
  );
}

export async function readProviderThrottle(
  provider: string
): Promise<number | null> {
  await ensureProviderSlotTable();
  const row = await queryOne<{ cap: number }>(
    `SELECT cap FROM provider_throttle
     WHERE provider = ? AND expires_at > unixepoch()`,
    [provider]
  );
  if (!row || !Number.isFinite(Number(row.cap))) return null;
  return Math.max(1, Math.floor(Number(row.cap)));
}

export async function clearProviderThrottle(provider: string): Promise<void> {
  await ensureProviderSlotTable();
  await execute(`DELETE FROM provider_throttle WHERE provider = ?`, [provider]);
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

/**
 * Drop every slot this token still holds. Shutdown uses it for the leases
 * this process is about to hand back, so a restart does not inherit them
 * for the rest of the TTL. A token this process no longer owns deletes
 * nothing.
 */
export async function releaseProviderSlotsForOwner(
  ownerToken: string
): Promise<number> {
  await ensureProviderSlotTable();
  const result = await execute(
    `DELETE FROM provider_slots WHERE owner_token = ?`,
    [ownerToken]
  );
  return result.rowsAffected;
}
