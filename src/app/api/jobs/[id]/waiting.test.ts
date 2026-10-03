/**
 * GET /api/jobs/[id] while the upload is still extracting: the player is the
 * only poller left once the voice page is gone, so it must keep a stalled
 * extract moving and surface an upload failure as the job's own failure.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  UPLOAD_ID_A,
  USER_A,
  buildRequest,
  jobRow,
  resetDatabase,
  routeParams,
  seedJob,
  seedUpload,
} from "@/test/harness";
import { execute } from "@/lib/turso";

const JOB_A = "dddddddd-0000-4000-8000-000000000001";

async function seedJobOverUpload(status: string) {
  const pdfPath = await seedUpload({
    id: UPLOAD_ID_A,
    userId: USER_A,
    text: "A book still being read. ".repeat(20),
  });
  await execute(
    `UPDATE uploads SET status = ?, char_count = 0,
       extract_attempts = 1, extract_started_at = unixepoch() - 400
     WHERE id = ?`,
    [status, UPLOAD_ID_A]
  );
  await seedJob({
    id: JOB_A,
    userId: USER_A,
    pdfStoragePath: pdfPath,
    status: "queued",
  });
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetDatabase();
});

describe("GET /api/jobs/[id] waiting for extracted text", () => {
  it("reports waiting_for_text and keeps a stalled extract moving", async () => {
    await seedJobOverUpload("extracting");
    const dispatch = await import("@/lib/jobs/dispatch-extract");
    const spy = vi.spyOn(dispatch, "nudgeUploadExtract").mockResolvedValue();

    const { GET } = await import("@/app/api/jobs/[id]/route");
    const response = await GET(
      await buildRequest(`/api/jobs/${JOB_A}`, { userId: USER_A }),
      routeParams({ id: JOB_A })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.job.waiting_for_text).toBe(true);
    expect(body.job.status).toBe("queued");
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await jobRow(JOB_A))?.status).toBe("queued");
  });

  it("fails a parked job when the upload itself failed", async () => {
    await seedJobOverUpload("failed");
    await execute(
      `UPDATE uploads SET error_message = 'Reading is taking too long. Try again.'
       WHERE id = ?`,
      [UPLOAD_ID_A]
    );

    const { GET } = await import("@/app/api/jobs/[id]/route");
    const response = await GET(
      await buildRequest(`/api/jobs/${JOB_A}`, { userId: USER_A }),
      routeParams({ id: JOB_A })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.job.status).toBe("failed");
    expect(body.job.error_message).toBe(
      "Reading is taking too long. Try again."
    );
    const row = await jobRow(JOB_A);
    expect(row?.status).toBe("failed");
    expect(row?.processing_lease_token).toBeNull();
  });

  it("does not flag a job whose upload is ready", async () => {
    const pdfPath = await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text: "A finished book. ".repeat(40),
    });
    await seedJob({
      id: JOB_A,
      userId: USER_A,
      pdfStoragePath: pdfPath,
      status: "queued",
    });

    const { GET } = await import("@/app/api/jobs/[id]/route");
    const response = await GET(
      await buildRequest(`/api/jobs/${JOB_A}`, { userId: USER_A }),
      routeParams({ id: JOB_A })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.job.waiting_for_text).toBeUndefined();
  });
});
