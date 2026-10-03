/**
 * Resolve an extract that never finishes.
 *
 * The Cloudflare extract Worker (Free plan) can be killed silently before it
 * can write `failed`, which leaves an upload `extracting` forever while the
 * status route keeps re-sending it every 180 s. Someone pressing "Make
 * audiobook" then spins on a promise that can never resolve.
 *
 * Whoever is still watching — the upload status poll or the player's job
 * poll — calls {@link advanceStalledUploadExtract} on every read. It counts
 * dispatches (`extract_attempts`) and age, then either falls back to
 * extracting on Vercel (small docs parse inline, the same path the complete
 * route already uses without the Worker) or, past the last cap, marks the
 * upload failed with a clear message instead of spinning forever. The
 * Cloudflare Worker's own limits and billing are untouched.
 */

import { nudgeUploadExtract } from "@/lib/jobs/dispatch-extract";
import {
  claimUploadExtractNudge,
  failUploadExtract,
  uploadStatus,
  type UploadRow,
} from "@/lib/turso/uploads";

/** After this many silent dispatches, try Vercel instead of the Worker. */
export const EXTRACT_FALLBACK_AFTER_ATTEMPTS = 2;
/** After this many dispatches, stop retrying and say so. */
export const EXTRACT_FAIL_AFTER_ATTEMPTS = 4;
/** Wall-clock cap from upload creation, however often it was re-sent. */
export const EXTRACT_FAIL_AFTER_SECONDS = 900;

export const EXTRACT_STALLED_MESSAGE =
  "Reading is taking too long. Try again.";

export type StalledExtractAction =
  | "none"
  | "failed"
  | "requeued-local"
  | "requeued-worker";

export function extractAttempts(row: UploadRow): number {
  return Number(row.extract_attempts || 0);
}

function extractAgeSeconds(row: UploadRow, now = Date.now()): number {
  const created = Number(row.created_at || 0);
  return created > 0 ? Math.max(0, Math.floor(now / 1000) - created) : 0;
}

function stalledTooLong(row: UploadRow, now = Date.now()): boolean {
  return (
    extractAttempts(row) >= EXTRACT_FAIL_AFTER_ATTEMPTS ||
    extractAgeSeconds(row, now) >= EXTRACT_FAIL_AFTER_SECONDS
  );
}

/**
 * One poll read's worth of stall resolution. Cheap when nothing is wrong:
 * a ready row is a no-op, and a fresh dispatch holds the claim window so
 * concurrent readers cannot double-send.
 */
export async function advanceStalledUploadExtract(
  row: UploadRow
): Promise<StalledExtractAction> {
  const status = uploadStatus(row);
  if (status === "ready") return "none";
  if (status === "failed") return "failed";

  if (stalledTooLong(row)) {
    await failUploadExtract(row.id, EXTRACT_STALLED_MESSAGE);
    return "failed";
  }

  // The claim window encodes both staleness checks (uploaded 20 s /
  // extracting 180 s): a dispatch that is still in flight owns the row.
  if (!(await claimUploadExtractNudge(row.id))) return "none";

  if (extractAttempts(row) >= EXTRACT_FALLBACK_AFTER_ATTEMPTS) {
    await nudgeUploadExtract(row.id, { preferLocal: true });
    return "requeued-local";
  }
  await nudgeUploadExtract(row.id);
  return "requeued-worker";
}
