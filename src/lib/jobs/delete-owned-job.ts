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
import { execute, query } from "@/lib/turso";
import { deleteFiles, listFiles } from "@/lib/storage";
import { releaseTakehomeCreateForJob } from "@/lib/jobs/takehome-identity";

export interface DeletedJobPurge {
  jobId: string;
  pdfStoragePath: unknown;
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
}

/** `pdfs/<uploadId>/content.txt` → `pdfs/<uploadId>` */
function uploadFolderFor(pdfStoragePath: unknown): string | null {
  if (typeof pdfStoragePath !== "string" || !pdfStoragePath) return null;
  const parts = pdfStoragePath.split("/");
  if (parts.length < 2 || parts[0] !== "pdfs" || !parts[1]) return null;
  if (parts[1].includes("..")) return null;
  return parts.slice(0, 2).join("/");
}

/** Prefix for this job's own objects. Rejects a path that could escape the folder. */
export function audiobookObjectPrefix(jobId: string): string | null {
  if (!jobId || jobId.length > 80) return null;
  if (/[\\/\0]/.test(jobId) || jobId.includes("..")) return null;
  return `audiobooks/${jobId}/`;
}

/**
 * Remove this job's audiobook objects, and the shared upload folder only
 * when no live sibling still references it. Listing the prefix is the
 * source of keys: a path remembered in `segments_json` is not deleted on
 * its own, so a retry does not call DeleteObject for objects already gone.
 * Idempotent. A missing object is success.
 */
export async function purgeDeletedJobStorage(input: DeletedJobPurge): Promise<void> {
  const keys = new Set<string>();
  const prefix = audiobookObjectPrefix(input.jobId);
  if (prefix) {
    for (const file of await listFiles(prefix)) keys.add(file);
  }

  const uploadFolder = uploadFolderFor(input.pdfStoragePath);
  const pdfStoragePath =
    typeof input.pdfStoragePath === "string" ? input.pdfStoragePath : "";
  if (uploadFolder && pdfStoragePath) {
    const siblings = await query<{ count: number | bigint }>(
      `SELECT COUNT(*) as count FROM jobs
       WHERE pdf_storage_path = ? AND id != ? AND deleted_at IS NULL`,
      [pdfStoragePath, input.jobId]
    );
    const siblingCount = Number(siblings[0]?.count ?? 0);
    if (siblingCount === 0) {
      for (const file of await listFiles(uploadFolder)) keys.add(file);
      await execute(`DELETE FROM uploads WHERE storage_path = ?`, [
        pdfStoragePath,
      ]).catch(() => {});
    } else {
      console.log(
        `[Job ${input.jobId}] keeping ${uploadFolder} — ${siblingCount} sibling job(s) still use it`
      );
    }
  }

  await deleteFiles([...keys]);
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
