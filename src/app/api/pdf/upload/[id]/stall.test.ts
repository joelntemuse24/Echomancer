/**
 * GET /api/pdf/upload/[id] shares one stall path with the player poll:
 * `advanceStuckExtract`. Node, then Cloudflare, then Vercel, then
 * "This file took too long to read. Try again."
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
const STUCK = "This file took too long to read. Try again.";

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.TRIGGER_SECRET_KEY;
  delete process.env.VERCEL_ENV;
  delete process.env.EXTRACT_WORKER_URL;
  delete process.env.EXTRACT_WORKER_SECRET;
  delete process.env.WORKER_URL;
  await resetDatabase();
});

async function seedExtractingUpload(opts: {
  attempts: number;
  host?: string | null;
  staleForSeconds?: number;
  acceptedAgoSeconds?: number;
}): Promise<string> {
  const { uploadId } = await uploadBookViaApi(BOOK, { userId: USER_A });
  if (!uploadId) throw new Error("upload did not return an id");
  await execute(
    `UPDATE uploads
     SET status = 'extracting', char_count = 0,
         extract_host = ?, extract_attempts = ?,
         extract_started_at = unixepoch() - ?,
         extract_accepted_at = unixepoch() - ?
     WHERE id = ?`,
    [
      opts.host === undefined ? "node" : opts.host,
      opts.attempts,
      opts.staleForSeconds ?? 400,
      opts.acceptedAgoSeconds ?? 30,
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
  it("re-sends a stale Node extract once per claim window", async () => {
    const uploadId = await seedExtractingUpload({ attempts: 1 });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 202 })
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env.WORKER_URL = "https://worker.example";

    const first = await getStatus(uploadId);
    const firstBody = await first.json();
    expect(first.status).toBe(200);
    expect(firstBody.status).toBe("extracting");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://worker.example/extract"
    );

    await getStatus(uploadId);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads the file on Vercel after Node has already been retried", async () => {
    const uploadId = await seedExtractingUpload({ attempts: 3, host: "node" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await getStatus(uploadId);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ready");
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await uploadRow(uploadId))?.status).toBe("ready");
  });

  it("marks the upload failed with one message past the attempt cap", async () => {
    const uploadId = await seedExtractingUpload({ attempts: 4 });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    process.env.WORKER_URL = "https://worker.example";

    const response = await getStatus(uploadId);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("failed");
    expect(body.error).toBe(STUCK);
    expect(body.code).toBe("EXTRACTION_FAILED");
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await uploadRow(uploadId))?.error_message).toBe(STUCK);
  });

  it("marks the upload failed past the 20-minute cap, however fresh the heartbeat", async () => {
    const uploadId = await seedExtractingUpload({
      attempts: 1,
      staleForSeconds: 5,
      acceptedAgoSeconds: 1200,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    process.env.WORKER_URL = "https://worker.example";

    const response = await getStatus(uploadId);
    const body = await response.json();

    expect(body.status).toBe("failed");
    expect(body.error).toBe(STUCK);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves a ready upload alone", async () => {
    const { uploadId } = await uploadBookViaApi(BOOK, { userId: USER_A });
    if (!uploadId) throw new Error("upload did not return an id");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await getStatus(uploadId);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ready");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
