/**
 * One H100 per clone book, shared across worker processes.
 *
 * The row is the lease. A book holds at most one. A dead worker stops
 * heartbeating and the row expires, so the GPU is not stuck. The global
 * ceiling and the per-user ceiling are counted from unexpired rows, in the
 * same statement that inserts, so two processes cannot both pass a full cap.
 *
 * Under the ceiling a long book runs its own single-GPU ramp. A short book
 * (at most {@link MODAL_CLONE_SHORT_BOOK_CHARS}) shares the oldest holder's
 * already-restored GPU instead of paying its own snapshot restore, and a
 * younger short book queues behind that one. Past either ceiling, the
 * oldest book still waiting shares the oldest holder's GPU, and younger
 * waiters queue. `min_containers` stays 0; this table does not keep a
 * container up.
 */

import { execute, query, queryOne } from "@/lib/turso";
import type { SlotSql } from "@/lib/tts/provider-slots";

export const MODAL_S2_MAX_GPUS_DEFAULT = 20;
export const MODAL_S2_MAX_GPUS_PER_USER_DEFAULT = 5;
/** A typo must not open an unbounded fleet. The live autoscaler is this high too. */
export const MODAL_S2_MAX_GPUS_LIMIT = 64;

export const CREATE_MODAL_GPU_LEASES_SQL = `
CREATE TABLE IF NOT EXISTS modal_gpu_leases (
  job_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)`;

const appDb: SlotSql = {
  execute: (sql, args) => execute(sql, args),
  queryOne: (sql, args) => queryOne(sql, args),
};

let tableReady = false;

export function resetModalGpuLeaseCache(): void {
  tableReady = false;
}

export async function ensureModalGpuLeaseTable(db: SlotSql = appDb): Promise<void> {
  if (db === appDb && tableReady) return;
  await db.execute(CREATE_MODAL_GPU_LEASES_SQL);
  if (db === appDb) tableReady = true;
}

function clampCap(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? "").trim());
  const chosen = Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
  return Math.min(MODAL_S2_MAX_GPUS_LIMIT, Math.max(1, chosen));
}

/** GPUs the fleet may have in flight. `MODAL_S2_MAX_GPUS`, default 20. */
export function modalCloneMaxGpus(env: NodeJS.ProcessEnv = process.env): number {
  return clampCap(env.MODAL_S2_MAX_GPUS, MODAL_S2_MAX_GPUS_DEFAULT);
}

/**
 * GPUs one user may have in flight. `MODAL_S2_MAX_GPUS_PER_USER`, default 5.
 * Never above the global ceiling.
 */
export function modalCloneMaxGpusPerUser(env: NodeJS.ProcessEnv = process.env): number {
  return Math.min(
    modalCloneMaxGpus(env),
    clampCap(env.MODAL_S2_MAX_GPUS_PER_USER, MODAL_S2_MAX_GPUS_PER_USER_DEFAULT)
  );
}

export type GpuLeaseView = {
  jobId: string;
  userId: string;
  createdAt: number;
  /**
   * Speakable characters, once the book is frozen. 0 means unknown.
   * A short book may share an already-restored GPU instead of opening one.
   */
  charCount?: number;
};

/**
 * A book this short hitchhikes on a warm GPU another book already holds.
 *
 * 20,000 characters is about 21 minutes at 15.85 characters per audio
 * second. An 11-minute book and a 2-page article are under it. A 10-hour
 * book is not, and still gets its own H100 while the ceiling has room.
 * Joining both books' rows in one `synthesize_batch` needs a per-item
 * reference in the container, which is a Modal redeploy. This share is
 * one call at a time on the container that is already up.
 */
export const MODAL_CLONE_SHORT_BOOK_CHARS = 20_000;

export function isShortCloneBook(charCount: number | undefined): boolean {
  return (charCount ?? 0) > 0 && (charCount ?? 0) <= MODAL_CLONE_SHORT_BOOK_CHARS;
}

export type CloneGpuDecision =
  | { action: "grant" }
  | { action: "solo" }
  | { action: "share"; partnerId: string }
  | { action: "queue" };

function inputCharCount(
  input: { jobId: string },
  waiters: GpuLeaseView[]
): number | undefined {
  return waiters.find((waiter) => waiter.jobId === input.jobId)?.charCount;
}

function byAge(a: GpuLeaseView, b: GpuLeaseView): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  if (a.jobId < b.jobId) return -1;
  if (a.jobId > b.jobId) return 1;
  return 0;
}

/**
 * Who may take a GPU, given the leases already held.
 *
 * A free slot goes to the oldest long book that fits both ceilings. A short
 * book with a live holder shares that holder's GPU even when the ceiling
 * has room. A book that does not fit shares only when it is the oldest
 * waiter, and only with the oldest holder (the oldest holder of its own
 * user when the per-user ceiling is what blocked it and the global ceiling
 * still has room). Every other waiter queues. A holder keeps its own ramp
 * unless it is that share partner.
 */
export function decideCloneGpuAdmission(input: {
  jobId: string;
  userId: string;
  createdAt: number;
  leases: GpuLeaseView[];
  /** Books that still need a GPU, including this one when it has no lease. */
  waiters: GpuLeaseView[];
  globalCap: number;
  perUserCap: number;
}): CloneGpuDecision {
  const leases = [...input.leases].sort(byAge);
  const heldIds = new Set(leases.map((lease) => lease.jobId));
  const waiters = input.waiters
    .filter((waiter) => !heldIds.has(waiter.jobId))
    .sort(byAge);
  const held = leases.find((lease) => lease.jobId === input.jobId);
  const userLeases = leases.filter((lease) => lease.userId === input.userId).length;
  const globalFull = leases.length >= input.globalCap;
  const userFull = userLeases >= input.perUserCap;
  const oldestShort = waiters.find((waiter) => isShortCloneBook(waiter.charCount));

  const oldestLive = (userId?: string): GpuLeaseView | undefined =>
    leases.find((lease) => !userId || lease.userId === userId);

  if (held) {
    const oldestWaiter = waiters[0];
    const ceilingBlocks = globalFull || userFull;
    if (!ceilingBlocks && oldestShort) {
      const holder = oldestLive();
      if (holder?.jobId === input.jobId) {
        return { action: "share", partnerId: oldestShort.jobId };
      }
      return { action: "solo" };
    }
    if (!oldestWaiter || !ceilingBlocks) return { action: "solo" };
    const partnerPool = globalFull ? undefined : oldestWaiter.userId;
    const holder = oldestLive(partnerPool);
    if (!holder || holder.jobId !== input.jobId) return { action: "solo" };
    return { action: "share", partnerId: oldestWaiter.jobId };
  }

  const thisBookIsShort = isShortCloneBook(inputCharCount(input, waiters));
  if (!globalFull && !userFull && thisBookIsShort && leases.length > 0) {
    if (oldestShort?.jobId === input.jobId) {
      const holder = oldestLive();
      if (holder) return { action: "share", partnerId: holder.jobId };
    }
    return { action: "queue" };
  }

  const eligible = waiters.filter((waiter) => {
    const count = leases.filter((lease) => lease.userId === waiter.userId).length;
    return count < input.perUserCap;
  });
  const freeGlobal = input.globalCap - leases.length;
  const userRoom = input.perUserCap - userLeases;
  const globalRank = eligible.findIndex((waiter) => waiter.jobId === input.jobId);
  const userRank = eligible
    .filter((waiter) => waiter.userId === input.userId)
    .findIndex((waiter) => waiter.jobId === input.jobId);
  if (freeGlobal > 0 && userRoom > 0 && globalRank >= 0 && globalRank < freeGlobal && userRank >= 0 && userRank < userRoom) {
    return { action: "grant" };
  }

  const oldestWaiter = waiters[0];
  if (!oldestWaiter || oldestWaiter.jobId !== input.jobId || leases.length === 0) {
    return { action: "queue" };
  }
  const holder = oldestLive(globalFull ? undefined : input.userId);
  if (!holder) return { action: "queue" };
  return { action: "share", partnerId: holder.jobId };
}

export type GpuLeaseAcquire = {
  ok: boolean;
  /** `book` is a second call for a book that already holds a live lease. */
  reason: "acquired" | "renewed" | "global" | "user" | "book";
};

/**
 * Insert this book's lease, or renew it when this owner already holds it.
 * One statement, so the count and the insert cannot disagree.
 */
export async function acquireModalGpuLease(
  opts: {
    jobId: string;
    userId: string;
    ownerToken: string;
    createdAt: number;
    ttlSeconds: number;
    globalCap: number;
    perUserCap: number;
  },
  db: SlotSql = appDb
): Promise<GpuLeaseAcquire> {
  await ensureModalGpuLeaseTable(db);
  await db.execute(`DELETE FROM modal_gpu_leases WHERE expires_at <= unixepoch()`);
  const ttl = Math.max(5, Math.min(600, Math.floor(opts.ttlSeconds)));
  const createdAt = Math.max(0, Math.floor(opts.createdAt));
  const result = await db.execute(
    `INSERT INTO modal_gpu_leases (job_id, user_id, owner_token, created_at, expires_at)
     SELECT ?, ?, ?, ?, unixepoch() + ?
     WHERE (
       SELECT COUNT(*) FROM modal_gpu_leases
       WHERE expires_at > unixepoch() AND job_id != ?
     ) < ?
     AND (
       SELECT COUNT(*) FROM modal_gpu_leases
       WHERE user_id = ? AND expires_at > unixepoch() AND job_id != ?
     ) < ?
     ON CONFLICT(job_id) DO UPDATE SET
       owner_token = excluded.owner_token,
       user_id = excluded.user_id,
       expires_at = excluded.expires_at
     WHERE modal_gpu_leases.owner_token = excluded.owner_token
        OR modal_gpu_leases.expires_at <= unixepoch()`,
    [
      opts.jobId,
      opts.userId,
      opts.ownerToken,
      createdAt,
      ttl,
      opts.jobId,
      Math.max(1, Math.floor(opts.globalCap)),
      opts.userId,
      opts.jobId,
      Math.max(1, Math.floor(opts.perUserCap)),
    ]
  );
  if (result.rowsAffected > 0) return { ok: true, reason: "acquired" };
  const row = await queryOneLease(db, opts.jobId);
  if (row && row.owner_token !== opts.ownerToken) return { ok: false, reason: "book" };
  const counts = await countLiveLeases(db, opts.userId);
  if (counts.user >= opts.perUserCap) return { ok: false, reason: "user" };
  return { ok: false, reason: "global" };
}

async function queryOneLease(
  db: SlotSql,
  jobId: string
): Promise<{ owner_token: string } | null> {
  return db.queryOne<{ owner_token: string }>(
    `SELECT owner_token FROM modal_gpu_leases
     WHERE job_id = ? AND expires_at > unixepoch()`,
    [jobId]
  );
}

export async function countLiveLeases(
  db: SlotSql,
  userId: string
): Promise<{ global: number; user: number }> {
  await ensureModalGpuLeaseTable(db);
  const global = await db.queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM modal_gpu_leases WHERE expires_at > unixepoch()`
  );
  const user = await db.queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM modal_gpu_leases
     WHERE user_id = ? AND expires_at > unixepoch()`,
    [userId]
  );
  return { global: Number(global?.n ?? 0), user: Number(user?.n ?? 0) };
}

export async function releaseModalGpuLease(
  opts: { jobId: string; ownerToken: string },
  db: SlotSql = appDb
): Promise<boolean> {
  await ensureModalGpuLeaseTable(db);
  const result = await db.execute(
    `DELETE FROM modal_gpu_leases WHERE job_id = ? AND owner_token = ?`,
    [opts.jobId, opts.ownerToken]
  );
  return result.rowsAffected > 0;
}

/** Heartbeat. A dead owner renews nothing, and the row expires. */
export async function renewModalGpuLeases(
  ownerToken: string,
  ttlSeconds: number,
  db: SlotSql = appDb
): Promise<number> {
  await ensureModalGpuLeaseTable(db);
  const ttl = Math.max(5, Math.min(600, Math.floor(ttlSeconds)));
  const result = await db.execute(
    `UPDATE modal_gpu_leases
     SET expires_at = unixepoch() + ?
     WHERE owner_token = ? AND expires_at > unixepoch()`,
    [ttl, ownerToken]
  );
  return result.rowsAffected;
}

export async function releaseModalGpuLeasesForOwner(
  ownerToken: string,
  db: SlotSql = appDb
): Promise<number> {
  await ensureModalGpuLeaseTable(db);
  const result = await db.execute(
    `DELETE FROM modal_gpu_leases WHERE owner_token = ?`,
    [ownerToken]
  );
  return result.rowsAffected;
}

const RUNNABLE_CLONE_SQL = `
SELECT id, user_id, COALESCE(created_at, 0) AS created_at,
       COALESCE(char_count, 0) AS char_count
FROM jobs
WHERE deleted_at IS NULL
  AND job_kind = 'takehome'
  AND catalog_voice_id LIKE 'clone:%'
  AND COALESCE(provider_pin, 'modal') = 'modal'
  AND (
    status IN ('queued', 'processing')
    OR (
      status = 'waiting'
      AND EXISTS (
        SELECT 1 FROM uploads u
        WHERE u.storage_path = jobs.pdf_storage_path
          AND u.status IN ('ready', 'failed')
      )
    )
  )
ORDER BY created_at ASC, id ASC`;

/** Clone books the drain can still run. Holders and waiters are split by the lease table. */
export async function listRunnableCloneBooks(): Promise<GpuLeaseView[]> {
  const rows = await query<{
    id: string;
    user_id: string;
    created_at: number;
    char_count: number;
  }>(RUNNABLE_CLONE_SQL);
  return rows.map((row) => ({
    jobId: row.id,
    userId: row.user_id,
    createdAt: Number(row.created_at) || 0,
    charCount: Number(row.char_count) || 0,
  }));
}

/**
 * Solo when this book can have its own GPU. Share with one partner when a
 * ceiling is full and this book is the oldest waiter or the oldest holder.
 * Queue otherwise, so a younger book does not jump the line.
 */
export async function admitModalCloneGpu(opts: {
  jobId: string;
  userId: string;
  ownerToken: string;
  createdAt: number;
  ttlSeconds: number;
  /** Frozen speakable length. A short book can share a warm GPU. */
  charCount?: number;
}): Promise<
  | { mode: "solo"; holdsLease: boolean }
  | { mode: "queue"; holdsLease: false }
  | { mode: "share"; partnerId: string; holdsLease: boolean }
> {
  const globalCap = modalCloneMaxGpus();
  const perUserCap = modalCloneMaxGpusPerUser();
  const decide = async () => {
    const leases = await listLiveModalGpuLeases();
    const waiters = await listRunnableCloneBooks();
    const self = waiters.find((book) => book.jobId === opts.jobId);
    if (!self) {
      waiters.push({
        jobId: opts.jobId,
        userId: opts.userId,
        createdAt: opts.createdAt,
        charCount: opts.charCount,
      });
    } else if ((opts.charCount ?? 0) > 0) {
      self.charCount = opts.charCount;
    }
    return {
      leases,
      decision: decideCloneGpuAdmission({
        jobId: opts.jobId,
        userId: opts.userId,
        createdAt: opts.createdAt,
        leases,
        waiters,
        globalCap,
        perUserCap,
      }),
    };
  };
  const first = await decide();
  const holds = first.leases.some((lease) => lease.jobId === opts.jobId);
  if (
    first.decision.action === "grant" ||
    first.decision.action === "solo" ||
    (first.decision.action === "share" && holds)
  ) {
    const acquired = await acquireModalGpuLease({
      ...opts,
      globalCap,
      perUserCap,
    });
    if (!acquired.ok && first.decision.action === "grant") {
      const second = await decide();
      if (second.decision.action === "share") {
        return { mode: "share", partnerId: second.decision.partnerId, holdsLease: false };
      }
      return { mode: "queue", holdsLease: false };
    }
    if (!acquired.ok && first.decision.action !== "share") {
      return { mode: "queue", holdsLease: false };
    }
    if (first.decision.action === "share") {
      return { mode: "share", partnerId: first.decision.partnerId, holdsLease: acquired.ok };
    }
    return { mode: "solo", holdsLease: acquired.ok };
  }
  if (first.decision.action === "share") {
    return { mode: "share", partnerId: first.decision.partnerId, holdsLease: false };
  }
  return { mode: "queue", holdsLease: false };
}

export async function listLiveModalGpuLeases(
  db: SlotSql = appDb
): Promise<GpuLeaseView[]> {
  await ensureModalGpuLeaseTable(db);
  if (db === appDb) {
    const rows = await query<{ job_id: string; user_id: string; created_at: number }>(
      `SELECT job_id, user_id, created_at FROM modal_gpu_leases
       WHERE expires_at > unixepoch()
       ORDER BY created_at ASC, job_id ASC`
    );
    return rows.map((row) => ({
      jobId: row.job_id,
      userId: row.user_id,
      createdAt: Number(row.created_at) || 0,
    }));
  }
  return [];
}
