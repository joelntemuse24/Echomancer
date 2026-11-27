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
import { sowellCallCap } from "@/lib/tts/sowell-voice";

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

/**
 * Fish, Edge, Paradee, and the other named providers stay at 32.
 * Kokoro is the fleet call cap (`sowellCallCap`: 16 on torch, 64 on a
 * 16×4 ONNX fleet). A hard 32 here is what held book cf04e126 at 32
 * calls while the pool had already planned 59.
 */
export const PROVIDER_SLOT_CAP_CEILING = 32;

function slotCapCeiling(provider: string): number {
  if (provider === "kokoro") return sowellCallCap();
  return PROVIDER_SLOT_CAP_CEILING;
}

function clampCap(cap: number, provider: string): number {
  if (!Number.isFinite(cap) || cap < 1) return 1;
  return Math.min(slotCapCeiling(provider), Math.floor(cap));
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
  const cap = clampCap(opts.cap, opts.provider);
  const ttl = clampTtl(opts.ttlSeconds);
  // A full table is one count. Walking every slot id is an INSERT each,
  // and on Kokoro that is 64 round trips per lane. A miss here is retried
  // by the book's single reclaim gate.
  try {
    const row = await db.queryOne<{ n: number | bigint | null }>(
      `SELECT COUNT(*) AS n FROM provider_slots
       WHERE provider = ? AND slot_id < ? AND expires_at > unixepoch()`,
      [opts.provider, cap]
    );
    const live = Number(row?.n ?? 0);
    if (Number.isFinite(live) && live >= cap) return null;
  } catch {
    // A failed count still tries the insert walk.
  }
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

/**
 * Drop this owner's Kokoro rows that are not a section still speaking.
 *
 * A section that exited on an error or an abort, or a claim that never
 * reached `release`, leaves a row the lease heartbeat keeps renewing. The
 * table then looks full to the same book. Live slot ids are the ones this
 * tick has acquired and not released; everything else of this owner is stale.
 * An empty live set deletes every Kokoro row for the token.
 */
export async function releaseStaleProviderSlots(
  opts: {
    provider: string;
    ownerToken: string;
    liveSlotIds: readonly number[];
  },
  db: SlotSql = appSql
): Promise<number> {
  await ensureProviderSlotTable(db);
  if (opts.liveSlotIds.length === 0) {
    const result = await db.execute(
      `DELETE FROM provider_slots
       WHERE provider = ? AND owner_token = ?`,
      [opts.provider, opts.ownerToken]
    );
    return result.rowsAffected;
  }
  const placeholders = opts.liveSlotIds.map(() => "?").join(", ");
  const result = await db.execute(
    `DELETE FROM provider_slots
     WHERE provider = ? AND owner_token = ?
       AND slot_id NOT IN (${placeholders})`,
    [opts.provider, opts.ownerToken, ...opts.liveSlotIds]
  );
  return result.rowsAffected;
}

/** Unexpired rows of this provider held by any other token. */
export async function providerSlotsHeldByOthers(
  opts: { provider: string; ownerToken: string },
  db: SlotSql = appSql
): Promise<number> {
  try {
    await ensureProviderSlotTable(db);
    const row = await db.queryOne<{ n: number | bigint | null }>(
      `SELECT COUNT(*) AS n FROM provider_slots
       WHERE provider = ? AND owner_token != ? AND expires_at > unixepoch()`,
      [opts.provider, opts.ownerToken]
    );
    const n = Number(row?.n ?? 0);
    return Number.isFinite(n) ? n : 0;
  } catch {
    // A failed read must not look like an empty table and keep the book
    // spinning. The caller defers; the next claim tries again.
    return Number.POSITIVE_INFINITY;
  }
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
  cap: number,
  maxWaitMs = 0
): Promise<HeldProviderSlot> {
  const lease = currentTakehomeLease();
  const held = await holdProviderSlot({
    provider,
    cap,
    ownerToken: lease?.token ?? `${provider}_${crypto.randomUUID()}`,
    jobId: lease?.jobId ?? null,
    ttlSeconds: 90,
    maxWaitMs,
  });
  if (!held) throw new ProviderSlotBusyError(provider);
  return held;
}

/**
 * How long a Kokoro lane waits for one of the fleet's permits before it
 * defers the book.
 *
 * `0` would make the fleet a strict race: a book whose lanes hold every
 * container would take the permit a finished section frees before another
 * book's lane, which is already waiting, could see it. A short wait lets the
 * other book interleave instead of waiting for the first wave to end. It is
 * bounded, so a genuinely full fleet still defers promptly.
 */
export const KOKORO_SLOT_WAIT_MS = 3_000;

/**
 * Backoff before a book that already holds Kokoro slots scans again.
 * The scan is one count (and, when a row is free, the insert walk). On a
 * remote table that count can take longer than this interval. The reclaim
 * gate sleeps this long anyway, plus a little jitter, so a slow scan cannot
 * start the next one immediately.
 */
export const KOKORO_RECLAIM_MS = 500;

export type KokoroReclaimGate = {
  /** The next scan waits {@link KOKORO_RECLAIM_MS} plus jitter. */
  armSleep: () => void;
  /**
   * Run `scan` one book at a time. After a miss, the following scan sleeps
   * the full reclaim interval even if this scan ran longer than that.
   * `shouldStop` is checked before the sleep and again before the scan.
   */
  run: <T>(
    shouldStop: () => boolean,
    scan: () => Promise<T | null>
  ) => Promise<T | null | "stop">;
};

export function createKokoroReclaimGate(deps?: {
  sleep?: (ms: number) => Promise<void>;
  jitterMs?: () => number;
}): KokoroReclaimGate {
  const sleep =
    deps?.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const jitterMs = deps?.jitterMs ?? (() => Math.floor(Math.random() * 50));
  let chain: Promise<void> = Promise.resolve();
  let sleepBeforeNext = false;
  return {
    armSleep() {
      sleepBeforeNext = true;
    },
    run(shouldStop, scan) {
      const run = chain.then(async () => {
        if (shouldStop()) return "stop" as const;
        if (sleepBeforeNext) {
          sleepBeforeNext = false;
          await sleep(KOKORO_RECLAIM_MS + Math.max(0, Math.floor(jitterMs())));
          if (shouldStop()) return "stop" as const;
        }
        const held = await scan();
        // A scan that already took a slot (or finished a section) is returned
        // even when the deadline passed while it ran. A miss does not start
        // another sleep once the caller is stopping.
        sleepBeforeNext = held == null && !shouldStop();
        if (held == null && shouldStop()) return "stop" as const;
        return held;
      });
      chain = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
  };
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
 *
 * Drew, Walter, George, and Heart all come from the one `echomancer-sowell` fleet,
 * so they take a **`kokoro`** permit with the fleet cap, not a per-voice
 * permit. A preview during a book therefore shares the fleet the book is
 * using instead of opening a call beyond `SOWELL_MAX_CONTAINERS` that would
 * only 429.
 */
export async function holdListenerSlot(
  providerId: string,
  edgeCap: number
): Promise<HeldProviderSlot | null> {
  if (providerId === "fish") return null;
  if (
    providerId === "drew" ||
    providerId === "sowell" ||
    providerId === "george" ||
    providerId === "heart"
  ) {
    return holdNamedProviderSlot("kokoro", sowellCallCap());
  }
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
