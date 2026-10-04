import { beforeEach, describe, expect, it } from "vitest";
import { USER_A, jobRow, resetDatabase, seedJob, seedUpload } from "@/test/harness";
import { execute } from "@/lib/turso";
import {
  queueWaitingAfterExtract,
  releaseWaitingTakehomesForUpload,
} from "@/lib/jobs/release-waiting-takehomes";
import { waitingReleaseForUpload } from "@/lib/jobs/waiting-takehome-sql";

const READY_UPLOAD = "55555555-5555-4555-8555-555555555555";
const OTHER_UPLOAD = "66666666-6666-4666-8666-666666666666";
const WAITING_ID = "dddddddd-0000-4000-8000-000000000091";
const SIBLING_ID = "dddddddd-0000-4000-8000-000000000092";

beforeEach(async () => {
  await resetDatabase();
});

async function insertUpload(opts: {
  id: string;
  status: string;
  error?: string | null;
}): Promise<string> {
  const storagePath = `pdfs/${opts.id}/content.txt`;
  await execute(
    `INSERT INTO uploads (id, user_id, storage_path, file_name, format, status, error_message)
     VALUES (?, ?, ?, 'book.txt', 'txt', ?, ?)`,
    [opts.id, USER_A, storagePath, opts.status, opts.error ?? null]
  );
  return storagePath;
}

describe("releaseWaitingTakehomesForUpload", () => {
  it("queues waiting take-homes when the file is ready", async () => {
    const path = await insertUpload({ id: READY_UPLOAD, status: "ready" });
    const otherPath = await insertUpload({ id: OTHER_UPLOAD, status: "extracting" });
    await seedJob({
      id: WAITING_ID,
      userId: USER_A,
      pdfStoragePath: path,
      status: "waiting",
    });
    await seedJob({
      id: SIBLING_ID,
      userId: USER_A,
      pdfStoragePath: otherPath,
      status: "waiting",
    });

    const result = await releaseWaitingTakehomesForUpload(READY_UPLOAD);
    expect(result).toEqual({ queued: 1, failed: 0 });
    expect((await jobRow(WAITING_ID))?.status).toBe("queued");
    expect((await jobRow(WAITING_ID))?.processing_lease_token).toBeNull();
    expect((await jobRow(SIBLING_ID))?.status).toBe("waiting");
  });

  it("fails waiting take-homes when the extract failed", async () => {
    const path = await insertUpload({
      id: READY_UPLOAD,
      status: "failed",
      error: "This file took too long to read. Try again.",
    });
    await seedJob({
      id: WAITING_ID,
      userId: USER_A,
      pdfStoragePath: path,
      status: "waiting",
    });
    await seedJob({
      id: SIBLING_ID,
      userId: USER_A,
      pdfStoragePath: path,
      status: "queued",
    });

    const result = await releaseWaitingTakehomesForUpload(READY_UPLOAD);
    expect(result).toEqual({ queued: 0, failed: 1 });
    const failed = await jobRow(WAITING_ID);
    expect(failed?.status).toBe("failed");
    expect(failed?.error_message).toBe(
      "This file took too long to read. Try again."
    );
    expect((await jobRow(SIBLING_ID))?.status).toBe("queued");
  });

  it("leaves a book waiting while its file is still being read", async () => {
    const path = await insertUpload({ id: READY_UPLOAD, status: "extracting" });
    await seedJob({
      id: WAITING_ID,
      userId: USER_A,
      pdfStoragePath: path,
      status: "waiting",
    });
    const result = await releaseWaitingTakehomesForUpload(READY_UPLOAD);
    expect(result).toEqual({ queued: 0, failed: 0 });
    expect((await jobRow(WAITING_ID))?.status).toBe("waiting");
  });

  it("does not revive a deleted waiting job", async () => {
    const path = await seedUpload({
      id: READY_UPLOAD,
      userId: USER_A,
      text: "A short chapter.",
    });
    await seedJob({
      id: WAITING_ID,
      userId: USER_A,
      pdfStoragePath: path,
      status: "waiting",
    });
    await execute(`UPDATE jobs SET deleted_at = unixepoch() WHERE id = ?`, [
      WAITING_ID,
    ]);
    const result = await releaseWaitingTakehomesForUpload(READY_UPLOAD);
    expect(result).toEqual({ queued: 0, failed: 0 });
    expect((await jobRow(WAITING_ID))?.status).toBe("waiting");
  });

  it("queues the parked book before the extract wake drains", async () => {
    const path = await insertUpload({ id: READY_UPLOAD, status: "ready" });
    await seedJob({
      id: WAITING_ID,
      userId: USER_A,
      pdfStoragePath: path,
      status: "waiting",
    });
    let seen = "";
    await queueWaitingAfterExtract(READY_UPLOAD, async () => {
      seen = String((await jobRow(WAITING_ID))?.status);
    });
    expect(seen).toBe("queued");
  });
});

describe("waitingReleaseForUpload", () => {
  it("queues a ready file, fails a failed file, and skips a file still being read", () => {
    expect(waitingReleaseForUpload("ready", null)).toEqual({ action: "queue" });
    expect(waitingReleaseForUpload("failed", "  unreadable  ")).toEqual({
      action: "fail",
      message: "unreadable",
    });
    expect(waitingReleaseForUpload("failed", "  ")).toEqual({
      action: "fail",
      message: "Couldn't read this. Try another file.",
    });
    expect(waitingReleaseForUpload("extracting", null)).toEqual({ action: "skip" });
    expect(waitingReleaseForUpload("uploaded", null)).toEqual({ action: "skip" });
  });
});
