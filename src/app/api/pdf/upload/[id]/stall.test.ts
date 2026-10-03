/**
 * GET /api/pdf/upload/[id] stall resolution.
 *
 * A Cloudflare Free-plan extract worker can die without writing `failed`,
 * which used to leave an upload `extracting` forever while the status poll
 * re-sent it every 180 s. The poll now resolves the stall itself: re-send,
 * fall back to Vercel, then fail with a clear message.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  USER_A,
  buildRequest,
  resetDatabase,
  routeParams,
  uploadBookViaApi,
} from "@/test/harness";
import { execute, queryOne } from "@/lib/turso";

const BOOK = "The lamps were lit along the quay. ".repeat(40);

beforeEach(async () => {
  vi.restoreAllMocks();
  delete process.env.TRIGGER_SECRET_KEY;
  delete process.env.VERCEL_ENV;
  delete process.env.EXTRACT_WORKER_URL;
  await resetDatabase();
});

async function seedExtractingUpload(opts: {
  attempts: number;
  ageSeconds?: number;
  staleForSeconds?: number;
}): Promise<string> {
  const { uploadId } = await uploadBookViaApi(BOOK, { userId: USER_A });
  if (!uploadId) throw new Error("upload did not return an id");
  // Pretend a dispatch already ran and the worker died silently: the row
  // sits in `extracting`, older than the 180 s claim window.
  await execute(
    `UPDATE uploads
     SET status = 'extracting', char_count = 0, extract_attempts = ?,
         extract_started_at = unixepoch() - ?, created_at = unixepoch() - ?
     WHERE id = ?`,
    [
      opts.attempts,
      opts.staleForSeconds ?? 400,
      opts.ageSeconds ?? 0,
      uploadId,
    ]
  );
  return uploadId;
}

async function getStatus(uploadId: string) {
  const { GET } = await import("@/app/api/pdf/upload/[id]/route");
  return GET(
    await buildRequest(`/api/pdf/upload/${uploadId}`, { userId: USER_A }),
    routeParams({ id: uploadId })
  );
}

async function uploadRow(uploadId: string) {
  return queryOne<{ status: string; error_message: string | null }>(
    `SELECT status, error_message FROM uploads WHERE id = ?`,
    [uploadId]
  );
}

describe("stalled extract resolution on the status poll", () => {
  it("re-sends a stalled extract once per claim window", async () => {
    const uploadId = await seedExtractingUpload({ attempts: 1 });
    const dispatch = await import("@/lib/jobs/dispatch-extract");
    const spy = vi.spyOn(dispatch, "nudgeUploadExtract").mockResolvedValue();

    const first = await getStatus(uploadId);
    const firstBody = await first.json();
    expect(first.status).toBe(200);
    expect(firstBody.status).toBe("extracting");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(uploadId);

    // A second read inside the claim window does not double-send.
    await getStatus(uploadId);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("falls back to Vercel after repeated silent worker misses", async () => {
    const uploadId = await seedExtractingUpload({ attempts: 2 });
    const dispatch = await import("@/lib/jobs/dispatch-extract");
    const spy = vi.spyOn(dispatch, "nudgeUploadExtract").mockResolvedValue();

    const response = await getStatus(uploadId);
    expect(response.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(uploadId, { preferLocal: true });
    expect((await uploadRow(uploadId))?.status).toBe("extracting");
  });

  it("marks the upload failed with a clear message past the attempt cap", async () => {
    const uploadId = await seedExtractingUpload({ attempts: 4 });
    const dispatch = await import("@/lib/jobs/dispatch-extract");
    const spy = vi.spyOn(dispatch, "nudgeUploadExtract").mockResolvedValue();

    const response = await getStatus(uploadId);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("failed");
    expect(body.error).toBe("Reading is taking too long. Try again.");
    expect(body.code).toBe("EXTRACTION_FAILED");
    expect(spy).not.toHaveBeenCalled();
    expect((await uploadRow(uploadId))?.status).toBe("failed");
  });

  it("marks the upload failed past the wall-clock cap, however few the attempts", async () => {
    const uploadId = await seedExtractingUpload({
      attempts: 0,
      ageSeconds: 901,
    });
    const dispatch = await import("@/lib/jobs/dispatch-extract");
    const spy = vi.spyOn(dispatch, "nudgeUploadExtract").mockResolvedValue();

    const response = await getStatus(uploadId);
    const body = await response.json();

    expect(body.status).toBe("failed");
    expect(body.error).toBe("Reading is taking too long. Try again.");
    expect(spy).not.toHaveBeenCalled();
  });

  it("leaves a ready upload alone", async () => {
    const { uploadId } = await uploadBookViaApi(BOOK, { userId: USER_A });
    if (!uploadId) throw new Error("upload did not return an id");
    const dispatch = await import("@/lib/jobs/dispatch-extract");
    const spy = vi.spyOn(dispatch, "nudgeUploadExtract").mockResolvedValue();

    const response = await getStatus(uploadId);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ready");
    expect(spy).not.toHaveBeenCalled();
  });
});
