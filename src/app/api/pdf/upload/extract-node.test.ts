import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  USER_A,
  buildRequest,
  resetDatabase,
  routeParams,
  seedUpload,
  UPLOAD_ID_A,
} from "@/test/harness";
import { execute } from "@/lib/turso";

describe("GET /api/pdf/upload/[id] extract fallback", () => {
  beforeEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.WORKER_URL;
    delete process.env.EXTRACT_WORKER_URL;
    delete process.env.EXTRACT_WORKER_SECRET;
    await resetDatabase();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.WORKER_URL;
    delete process.env.EXTRACT_WORKER_URL;
    delete process.env.EXTRACT_WORKER_SECRET;
  });

  it("stops spinning once a Node extract passes the cap", async () => {
    await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text: "The lamps were lit along the quay. ".repeat(4),
    });
    await execute(
      `UPDATE uploads
         SET status = 'extracting', extract_host = 'node', extract_attempts = 4,
             extract_started_at = unixepoch() - 400,
             extract_accepted_at = unixepoch() - 400
       WHERE id = ?`,
      [UPLOAD_ID_A]
    );
    process.env.WORKER_URL = "https://worker.example";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { GET } = await import("@/app/api/pdf/upload/[id]/route");
    const response = await GET(
      await buildRequest(`/api/pdf/upload/${UPLOAD_ID_A}`, { userId: USER_A }),
      routeParams({ id: UPLOAD_ID_A })
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.status).toBe("failed");
    expect(body.error).toBe("This file took too long to read. Try again.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
