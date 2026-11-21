/**
 * Ownership checks shared by every job and storage route.
 *
 * Two rules run through this file:
 *   1. A request without a valid signed session cannot reach owned data.
 *   2. A job or object that belongs to another session is reported as **404**,
 *      not 403 — otherwise the API becomes an existence oracle for job ids.
 */

import type { NextRequest } from "next/server";
import { AppError } from "@/lib/errors";
import {
  readSession,
  resolveSessionUserId,
  type Session,
} from "@/lib/auth/session";
import { queryOne } from "@/lib/turso";

export class SessionRequiredError extends AppError {
  constructor() {
    super(
      "SESSION_REQUIRED",
      "Your session has expired. Reload the page and upload your book again.",
      401
    );
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Job not found") {
    super("NOT_FOUND", message, 404);
  }
}

export async function requireSession(request: NextRequest): Promise<Session> {
  const userId = await resolveSessionUserId(request);
  if (!userId) throw new SessionRequiredError();
  const session = await readSession(request);
  if (!session) throw new SessionRequiredError();
  return { ...session, userId };
}

export interface OwnedJobRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  status: string;
  job_kind: string | null;
  pdf_storage_path: string;
}

/**
 * Load a job the caller owns, or throw 404. Callers that need more columns can
 * pass a projection; `id`, `user_id`, `status`, `job_kind` and
 * `pdf_storage_path` are always included.
 */
export async function requireOwnedJob(
  request: NextRequest,
  jobId: string,
  columns = "*"
): Promise<{ session: Session; job: OwnedJobRow }> {
  const session = await requireSession(request);
  const job = await queryOne<OwnedJobRow>(
    `SELECT ${columns} FROM jobs WHERE id = ? AND deleted_at IS NULL`,
    [jobId]
  );
  if (!job || job.user_id !== session.userId) throw new NotFoundError();
  return { session, job };
}

/**
 * Load a job this session owns, including one already soft-deleted.
 * A second DELETE uses this so storage cleanup can be finished. Every other
 * route keeps the 404 from {@link requireOwnedJob}. Another session's row,
 * deleted or not, is still 404.
 */
export async function requireOwnedJobIncludingDeleted(
  request: NextRequest,
  jobId: string
): Promise<{ session: Session; job: OwnedJobRow }> {
  const session = await requireSession(request);
  const job = await queryOne<OwnedJobRow>(
    `SELECT * FROM jobs WHERE id = ?`,
    [jobId]
  );
  if (!job || job.user_id !== session.userId) throw new NotFoundError();
  return { session, job };
}

/**
 * Storage objects are namespaced by their owner's resource:
 *   `pdfs/<uploadId>/…`      → the upload record
 *   `audiobooks/<jobId>/…`   → the job record
 *   `clones/<cloneId>/…`     → cloned_voices, or a pending clone_uploads row
 * Anything else is unreachable through the proxy.
 */
export async function ownsStoragePath(
  userId: string,
  storagePath: string
): Promise<boolean> {
  const [prefix, resourceId] = storagePath.split("/");
  if (!prefix || !resourceId) return false;

  if (!/^[A-Za-z0-9_-]{1,80}$/.test(resourceId)) return false;

  if (prefix === "audiobooks") {
    const row = await queryOne<{ user_id: string }>(
      `SELECT user_id FROM jobs WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [resourceId]
    );
    return row?.user_id === userId;
  }

  if (prefix === "pdfs") {
    const row = await queryOne<{ user_id: string }>(
      `SELECT user_id FROM uploads WHERE id = ? LIMIT 1`,
      [resourceId]
    );
    const folder = `pdfs/${resourceId}/`;
    if (row) {
      if (row.user_id !== userId) return false;
      // The uploads row outlives the soft-delete until the purge. A folder
      // whose jobs are all deleted is not playable. A folder with no job
      // yet, or with a live sibling, still is.
      const refs = await queryOne<{ live: number | bigint; total: number | bigint }>(
        `SELECT
           SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) as live,
           COUNT(*) as total
         FROM jobs
         WHERE substr(pdf_storage_path, 1, ?) = ?`,
        [folder.length, folder]
      );
      const total = Number(refs?.total ?? 0);
      const live = Number(refs?.live ?? 0);
      if (total > 0 && live === 0) return false;
      return true;
    }
    // Uploads created before ownership tracking existed have no row; fall back
    // to a live job that references this folder so old libraries keep playing.
    const viaJob = await queryOne<{ user_id: string }>(
      `SELECT user_id FROM jobs
       WHERE deleted_at IS NULL AND substr(pdf_storage_path, 1, ?) = ?
       LIMIT 1`,
      [folder.length, folder]
    );
    return viaJob?.user_id === userId;
  }

  if (prefix === "clones") {
    const row = await queryOne<{ user_id: string }>(
      `SELECT user_id FROM cloned_voices WHERE id = ? LIMIT 1`,
      [resourceId]
    );
    if (row) return row.user_id === userId;
    const pending = await queryOne<{ user_id: string }>(
      `SELECT user_id FROM clone_uploads WHERE id = ? LIMIT 1`,
      [resourceId]
    );
    return pending?.user_id === userId;
  }

  return false;
}
