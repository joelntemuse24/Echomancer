/**
 * When a file finishes reading, its parked take-homes become runnable.
 * `ready` → `queued`. `failed` → `failed` with the upload's message.
 * Anything still being read is left `waiting`, so the legacy Trigger
 * drain still cannot claim it.
 */

import { execute } from "@/lib/turso";
import { getUploadById } from "@/lib/turso/uploads";
import {
  FAIL_WAITING_TAKEHOMES_SQL,
  QUEUE_WAITING_TAKEHOMES_SQL,
  waitingReleaseForUpload,
} from "@/lib/jobs/waiting-takehome-sql";

export async function releaseWaitingTakehomesForUpload(
  uploadId: string
): Promise<{ queued: number; failed: number }> {
  const upload = await getUploadById(uploadId);
  if (!upload?.storage_path) return { queued: 0, failed: 0 };
  const decision = waitingReleaseForUpload(upload.status, upload.error_message);
  if (decision.action === "skip") return { queued: 0, failed: 0 };

  if (decision.action === "queue") {
    const result = await execute(QUEUE_WAITING_TAKEHOMES_SQL, [
      upload.storage_path,
    ]);
    if (result.rowsAffected > 0) {
      console.info(
        `[extract] queued ${result.rowsAffected} waiting take-home(s) for ${uploadId}`
      );
    }
    return { queued: result.rowsAffected, failed: 0 };
  }

  const result = await execute(FAIL_WAITING_TAKEHOMES_SQL, [
    decision.message,
    upload.storage_path,
  ]);
  if (result.rowsAffected > 0) {
    console.info(
      `[extract] failed ${result.rowsAffected} waiting take-home(s) for ${uploadId}`
    );
  }
  return { queued: 0, failed: result.rowsAffected };
}

/**
 * Extract-finished hook: queue (or fail) parked books, then wake the drain.
 * Promotion runs first so the drain sees `queued` rows. A promotion error
 * still wakes the drain; the yield check also counts a `waiting` job whose
 * upload is already ready or failed.
 */
export async function queueWaitingAfterExtract<T>(
  uploadId: string,
  drain: () => Promise<T>
): Promise<T> {
  try {
    await releaseWaitingTakehomesForUpload(uploadId);
  } catch (err) {
    console.error(
      `[takehome-worker] could not queue waiting jobs for ${uploadId}`,
      err instanceof Error ? err.message : err
    );
  }
  return drain();
}
