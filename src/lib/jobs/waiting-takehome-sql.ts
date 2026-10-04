/**
 * Move take-homes parked `waiting` once their file has been read.
 * Shared by the Node worker, Vercel extract, and the Cloudflare Worker
 * so the WHERE clause cannot drift. A book still `uploaded` or
 * `extracting` is left alone.
 */

export const EXTRACT_UNREADABLE_MESSAGE = "Couldn't read this. Try another file.";

export const QUEUE_WAITING_TAKEHOMES_SQL = `UPDATE jobs
   SET status = 'queued',
       processing_lease_token = NULL,
       lease_expires_at = NULL,
       processing_started_at = NULL,
       updated_at = unixepoch()
   WHERE deleted_at IS NULL
     AND job_kind = 'takehome'
     AND status = 'waiting'
     AND pdf_storage_path = ?`;

export const FAIL_WAITING_TAKEHOMES_SQL = `UPDATE jobs
   SET status = 'failed',
       error_message = ?,
       processing_lease_token = NULL,
       lease_expires_at = NULL,
       processing_started_at = NULL,
       updated_at = unixepoch()
   WHERE deleted_at IS NULL
     AND job_kind = 'takehome'
     AND status = 'waiting'
     AND pdf_storage_path = ?`;

export type WaitingRelease =
  | { action: "queue" }
  | { action: "fail"; message: string }
  | { action: "skip" };

export function waitingReleaseForUpload(
  status: string | null | undefined,
  errorMessage: string | null | undefined
): WaitingRelease {
  if (status === "ready") return { action: "queue" };
  if (status === "failed") {
    const message = errorMessage?.trim() || EXTRACT_UNREADABLE_MESSAGE;
    return { action: "fail", message };
  }
  return { action: "skip" };
}
