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
import { readSession, type Session } from "@/lib/auth/session";
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
  const session = await readSession(request);
  if (!session) throw new SessionRequiredError();
  return session;
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

/** True when `userId` owns the upload behind `storagePath`. */
export async function ownsUploadPath(
  userId: string,
  storagePath: string
): Promise<boolean> {
  const row = await queryOne<{ user_id: string }>(
    `SELECT user_id FROM uploads WHERE storage_path = ? OR source_path = ? LIMIT 1`,
    [storagePath, storagePath]
  );
  return row?.user_id === userId;
}

/**
 * Storage objects are namespaced by their owner's resource:
 *   `pdfs/<uploadId>/…`      → the upload record
 *   `audiobooks/<jobId>/…`   → the job record
 * Anything else is unreachable through the proxy.
 */
export async function ownsStoragePath(
  userId: string,
  storagePath: string
): Promise<boolean> {
  const [prefix, resourceId] = storagePath.split("/");
  if (!prefix || !resourceId) return false;

  if (prefix === "audiobooks") {
    const row = await queryOne<{ user_id: string }>(
      `SELECT user_id FROM jobs WHERE id = ? LIMIT 1`,
      [resourceId]
    );
    return row?.user_id === userId;
  }

  if (prefix === "pdfs") {
    const row = await queryOne<{ user_id: string }>(
      `SELECT user_id FROM uploads WHERE id = ? LIMIT 1`,
      [resourceId]
    );
    if (row) return row.user_id === userId;
    // Uploads created before ownership tracking existed have no row; fall back
    // to any job that references the path so old libraries keep playing.
    const viaJob = await queryOne<{ user_id: string }>(
      `SELECT user_id FROM jobs WHERE pdf_storage_path LIKE ? LIMIT 1`,
      [`pdfs/${resourceId}/%`]
    );
    return viaJob?.user_id === userId;
  }

  return false;
}
