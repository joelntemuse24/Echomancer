import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { USER_A, resetDatabase, seedUpload } from "@/test/harness";
import { execute, queryOne } from "@/lib/turso";
import { UPLOAD_ID_A } from "@/test/harness";

const trigger = vi.fn().mockResolvedValue({ id: "run_test" });

vi.mock("@trigger.dev/sdk", () => ({
  configure: vi.fn(),
  tasks: {
    trigger: (...args: unknown[]) => trigger(...args),
  },
}));

describe("dispatchUploadExtract", () => {
  beforeEach(async () => {
    vi.unstubAllGlobals();
    trigger.mockClear();
    delete process.env.EXTRACT_WORKER_URL;
    delete process.env.EXTRACT_WORKER_SECRET;
    delete process.env.VERCEL_ENV;
    process.env.TRIGGER_SECRET_KEY = "tr_test_secret";
    await resetDatabase();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.VERCEL_ENV;
  });

  it("does not enqueue Trigger upload.extract when a Worker URL is set", async () => {
    await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text: "The lamps were lit along the quay. ".repeat(20),
    });
    await execute(`UPDATE uploads SET status = 'uploaded' WHERE id = ?`, [
      UPLOAD_ID_A,
    ]);

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "extracting" }), { status: 202 })
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env.EXTRACT_WORKER_URL = "https://extract.example.workers.dev";
    process.env.EXTRACT_WORKER_SECRET = "extract-secret";

    const { dispatchUploadExtract } = await import("@/lib/jobs/dispatch-extract");
    const result = await dispatchUploadExtract(UPLOAD_ID_A);

    expect(result).toBe("worker");
    expect(trigger).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://extract.example.workers.dev");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer extract-secret",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({ uploadId: UPLOAD_ID_A });

    const row = await queryOne<{ status: string }>(
      `SELECT status FROM uploads WHERE id = ?`,
      [UPLOAD_ID_A]
    );
    expect(row?.status).toBe("extracting");
  });

  it("extracts in-process without Trigger when no Worker is configured", async () => {
    const text = "The lamps were lit along the quay. ".repeat(20);
    const path = await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text,
    });
    const { uploadFile } = await import("@/lib/storage");
    await uploadFile(
      `pdfs/${UPLOAD_ID_A}`,
      "source.txt",
      Buffer.from(text, "utf-8"),
      "text/plain"
    );
    await execute(
      `UPDATE uploads SET status = 'uploaded', char_count = 0 WHERE id = ?`,
      [UPLOAD_ID_A]
    );

    const { dispatchUploadExtract } = await import("@/lib/jobs/dispatch-extract");
    const result = await dispatchUploadExtract(UPLOAD_ID_A);

    expect(result).toBe("inline");
    expect(trigger).not.toHaveBeenCalled();
    const row = await queryOne<{ status: string; char_count: number }>(
      `SELECT status, char_count FROM uploads WHERE id = ?`,
      [UPLOAD_ID_A]
    );
    expect(row?.status).toBe("ready");
    expect(Number(row?.char_count)).toBeGreaterThan(50);
    expect(path).toContain(UPLOAD_ID_A);
  });

  it("production without Worker extracts small docs inline and never hits Trigger", async () => {
    const previousVercel = process.env.VERCEL_ENV;
    const previousNode = process.env.NODE_ENV;
    process.env.VERCEL_ENV = "production";
    process.env.NODE_ENV = "production";

    const text = "The lamps were lit along the quay. ".repeat(20);
    await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text,
    });
    const { uploadFile } = await import("@/lib/storage");
    await uploadFile(
      `pdfs/${UPLOAD_ID_A}`,
      "source.txt",
      Buffer.from(text, "utf-8"),
      "text/plain"
    );
    await execute(
      `UPDATE uploads SET status = 'uploaded', char_count = 0, byte_size = 1200 WHERE id = ?`,
      [UPLOAD_ID_A]
    );

    const { dispatchUploadExtract } = await import("@/lib/jobs/dispatch-extract");
    const result = await dispatchUploadExtract(UPLOAD_ID_A);

    expect(result).toBe("inline");
    expect(trigger).not.toHaveBeenCalled();
    const row = await queryOne<{ status: string }>(
      `SELECT status FROM uploads WHERE id = ?`,
      [UPLOAD_ID_A]
    );
    expect(row?.status).toBe("ready");

    if (previousVercel === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previousVercel;
    if (previousNode !== undefined) process.env.NODE_ENV = previousNode;
  });

  it("throws when the Worker is configured and rejects the job", async () => {
    await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text: "The lamps were lit along the quay. ".repeat(20),
    });
    await execute(`UPDATE uploads SET status = 'uploaded' WHERE id = ?`, [
      UPLOAD_ID_A,
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 500 }))
    );
    process.env.EXTRACT_WORKER_URL = "https://extract.example.workers.dev";
    process.env.EXTRACT_WORKER_SECRET = "extract-secret";

    const { dispatchUploadExtract } = await import("@/lib/jobs/dispatch-extract");
    await expect(dispatchUploadExtract(UPLOAD_ID_A)).rejects.toMatchObject({
      code: "EXTRACT_WORKER_FAILED",
    });
    expect(trigger).not.toHaveBeenCalled();
  });
});
