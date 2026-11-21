/**
 * Delete a library row before its objects.
 *
 * A long book is hundreds of R2 keys. Deleting them one by one used to hit
 * the route's 60s cap before `deleted_at` was set, so the book stayed in
 * the library with its audio already gone. The row is marked deleted first.
 * `audiobooks/<jobId>/` is then listed and removed with DeleteObjects,
 * 1,000 keys per call, after the response.
 */

import { after } from "next/server";
import { execute, query, queryOne } from "@/lib/turso";
import { deleteFiles, listFiles } from "@/lib/storage";
import { releaseTakehomeCreateForJob } from "@/lib/jobs/takehome-identity";
import { cancelCpuTasksForJob } from "@/lib/cpu/tasks";

/** Job and upload ids are UUIDs. The charset also admits older test ids. */
const OBJECT_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** One list that already paginates, plus a few retries when a batch reports errors. */
const PURGE_PASSES = 4;

/** Below this, one successful DeleteObjects emptied the list we just read. */
const FULL_LIST_HINT = 1000;

export interface DeletedJobPurge {
  jobId: string;
  /** The session that deleted the row. A mismatch deletes nothing. */
  userId: string;
  /**
   * Ignored. The purge reads `jobs.pdf_storage_path` for this id so a
   * caller cannot aim the delete at another upload.
   */
  pdfStoragePath?: unknown;
}

/**
 * Hide the row and drop the lease and the take-home create key.
 * A ready, failed, or cancelled book keeps its status. Anything still
 * running is cancelled so a worker cannot publish over the delete.
 * Safe to call again: a second pass leaves `deleted_at` as it was.
 */
export async function softDeleteJob(jobId: string, userId: string): Promise<void> {
  await execute(
    `UPDATE jobs SET
       deleted_at = COALESCE(deleted_at, unixepoch()),
       status = CASE
         WHEN status NOT IN ('ready', 'failed', 'cancelled') THEN 'cancelled'
         ELSE status
       END,
       error_message = CASE
         WHEN status NOT IN ('ready', 'failed', 'cancelled') THEN 'Deleted by user'
         ELSE error_message
       END,
       processing_lease_token = NULL,
       lease_expires_at = NULL,
       processing_started_at = NULL,
       updated_at = unixepoch()
     WHERE id = ? AND user_id = ?`,
    [jobId, userId]
  );
  await releaseTakehomeCreateForJob(jobId);
  await cancelCpuTasksForJob(jobId).catch((err) => {
    console.warn(
      `[Job ${jobId}] cpu tasks were not cancelled:`,
      err instanceof Error ? err.message : err
    );
  });
}

/** `pdfs/<uploadId>/content.txt` → `pdfs/<uploadId>/` */
export function uploadObjectPrefix(pdfStoragePath: unknown): string | null {
  if (typeof pdfStoragePath !== "string" || !pdfStoragePath) return null;
  const parts = pdfStoragePath.split("/");
  if (parts.length < 3 || parts[0] !== "pdfs" || !parts[2]) return null;
  const uploadId = parts[1] ?? "";
  if (!OBJECT_ID.test(uploadId)) return null;
  return `pdfs/${uploadId}/`;
}

/** Prefix for this job's own objects, with the trailing slash a list requires. */
export function audiobookObjectPrefix(jobId: string): string | null {
  if (!OBJECT_ID.test(jobId)) return null;
  return `audiobooks/${jobId}/`;
}

/**
 * Keys that are strictly inside `prefix`. `prefix` must end in `/`.
 * A neighbor (`…/job-extra/…`) and a `..` segment are dropped.
 */
export function keysUnderPrefix(keys: readonly string[], prefix: string): string[] {
  if (!prefix.endsWith("/")) return [];
  const kept: string[] = [];
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    if (!rest) continue;
    const parts = rest.split("/");
    if (parts.some((part) => part === "" || part === "." || part === "..")) continue;
    kept.push(key);
  }
  return kept;
}

async function ownerOfDeletedJob(jobId: string): Promise<string | null> {
  const row = await queryOne<{ user_id: string; deleted_at: number | null }>(
    `SELECT user_id, deleted_at FROM jobs WHERE id = ?`,
    [jobId]
  );
  if (!row || row.deleted_at == null) return null;
  return row.user_id;
}

async function stillThisUsersDelete(jobId: string, userId: string): Promise<boolean> {
  const owner = await ownerOfDeletedJob(jobId);
  return owner != null && owner === userId;
}

/**
 * List and delete `prefix` a few times. A reported DeleteObjects error
 * does not skip the keys already gathered; the next pass lists what remains.
 * Returns once the prefix is empty or the list was small and the delete
 * succeeded. Throws when objects are still there after the last pass.
 */
async function deleteListedPrefix(
  jobId: string,
  userId: string,
  prefix: string
): Promise<void> {
  let pending: unknown;
  for (let pass = 0; pass < PURGE_PASSES; pass++) {
    if (!(await stillThisUsersDelete(jobId, userId))) return;
    const unique = keysUnderPrefix(await listFiles(prefix), prefix);
    if (unique.length === 0) return;
    try {
      await deleteFiles(unique);
      pending = undefined;
    } catch (err) {
      pending = err;
      continue;
    }
    if (unique.length < FULL_LIST_HINT) return;
  }
  if (!(await stillThisUsersDelete(jobId, userId))) return;
  const left = keysUnderPrefix(await listFiles(prefix), prefix);
  if (left.length === 0) return;
  if (pending instanceof Error) throw pending;
  throw new Error(`storage purge left ${left.length} object(s)`);
}

/**
 * Remove `audiobooks/<jobId>/` only when this row is still soft-deleted.
 * Does not touch `pdfs/`. The worker calls this when a tick notices the delete
 * after an upload that already started.
 */
export async function purgeDeletedAudiobook(jobId: string): Promise<void> {
  const prefix = audiobookObjectPrefix(jobId);
  if (!prefix) return;
  const owner = await ownerOfDeletedJob(jobId);
  if (!owner) return;
  await deleteListedPrefix(jobId, owner, prefix);
}

async function pdfPrefixIfOrphaned(
  jobId: string,
  userId: string
): Promise<{ prefix: string; uploadId: string } | null> {
  const row = await queryOne<{ pdf_storage_path: string | null }>(
    `SELECT pdf_storage_path FROM jobs WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL`,
    [jobId, userId]
  );
  const prefix = uploadObjectPrefix(row?.pdf_storage_path);
  if (!prefix) return null;
  const uploadId = prefix.split("/")[1] ?? "";
  if (!OBJECT_ID.test(uploadId)) return null;

  const folderOwner = await queryOne<{ user_id: string | null }>(
    `SELECT user_id FROM uploads
     WHERE id = ? OR substr(storage_path, 1, ?) = ?
     LIMIT 1`,
    [uploadId, prefix.length, prefix]
  );
  if (folderOwner?.user_id && folderOwner.user_id !== userId) return null;

  const siblings = await query<{ count: number | bigint }>(
    `SELECT COUNT(*) as count FROM jobs
     WHERE id != ? AND deleted_at IS NULL
       AND substr(pdf_storage_path, 1, ?) = ?`,
    [jobId, prefix.length, prefix]
  );
  if (Number(siblings[0]?.count ?? 0) > 0) {
    console.log(`[Job ${jobId}] keeping ${prefix} — a live book still uses it`);
    return null;
  }
  return { prefix, uploadId };
}

async function dropUploadRow(userId: string, uploadId: string, prefix: string): Promise<void> {
  await execute(
    `DELETE FROM uploads
     WHERE (user_id = ? OR user_id IS NULL)
       AND (id = ? OR substr(storage_path, 1, ?) = ?)`,
    [userId, uploadId, prefix.length, prefix]
  ).catch(() => {});
}

/**
 * Remove this job's audiobook objects, and the shared upload folder only
 * when no live sibling still uses that folder and the uploads row is this
 * user's. Listing the prefix is the source of keys. Idempotent.
 * A row that is not soft-deleted, or that belongs to someone else, is left
 * untouched.
 */
export async function purgeDeletedJobStorage(input: DeletedJobPurge): Promise<void> {
  const prefix = audiobookObjectPrefix(input.jobId);
  if (!prefix) return;
  if (!(await stillThisUsersDelete(input.jobId, input.userId))) return;

  const pdf = await pdfPrefixIfOrphaned(input.jobId, input.userId);
  const audioKeys = keysUnderPrefix(await listFiles(prefix), prefix);
  const pdfKeys = pdf ? keysUnderPrefix(await listFiles(pdf.prefix), pdf.prefix) : [];
  const keys = [...new Set([...audioKeys, ...pdfKeys])];
  if (keys.length > 0) {
    if (!(await stillThisUsersDelete(input.jobId, input.userId))) return;
    try {
      await deleteFiles(keys);
    } catch (err) {
      await deleteListedPrefix(input.jobId, input.userId, prefix).catch(() => undefined);
      if (pdf) {
        await deleteListedPrefix(input.jobId, input.userId, pdf.prefix).catch(() => undefined);
      }
      throw err;
    }
  }
  if (keys.length >= FULL_LIST_HINT) {
    await deleteListedPrefix(input.jobId, input.userId, prefix);
    if (pdf) await deleteListedPrefix(input.jobId, input.userId, pdf.prefix);
  }
  if (pdf && (await stillThisUsersDelete(input.jobId, input.userId))) {
    await dropUploadRow(input.userId, pdf.uploadId, pdf.prefix);
  }
}

/**
 * Schedule {@link purgeDeletedJobStorage} after the response.
 * `after` throws outside a request, which is how the route handlers are
 * called in unit tests; there the purge finishes before the handler returns.
 */
export async function scheduleDeletedJobPurge(input: DeletedJobPurge): Promise<void> {
  const run = () =>
    purgeDeletedJobStorage(input).catch((err) => {
      console.error(
        `[Job ${input.jobId}] storage purge failed:`,
        err instanceof Error ? err.message : err
      );
    });
  try {
    after(run);
  } catch {
    await run();
  }
}
