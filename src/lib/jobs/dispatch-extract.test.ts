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
    delete process.env.WORKER_URL;
    delete process.env.TAKEHOME_WORKER_URL;
    delete process.env.WORKER_SECRET;
    delete process.env.VERCEL_ENV;
    process.env.TRIGGER_SECRET_KEY = "tr_test_secret";
    await resetDatabase();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.VERCEL_ENV;
    delete process.env.WORKER_URL;
    delete process.env.EXTRACT_WORKER_URL;
    delete process.env.EXTRACT_WORKER_SECRET;
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

  it("falls back to local extract when Cloudflare rejects the job", async () => {
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
    await execute(`UPDATE uploads SET status = 'uploaded', char_count = 0 WHERE id = ?`, [
      UPLOAD_ID_A,
    ]);
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    process.env.EXTRACT_WORKER_URL = "https://extract.example.workers.dev";
    process.env.EXTRACT_WORKER_SECRET = "extract-secret";

    const { dispatchUploadExtract } = await import("@/lib/jobs/dispatch-extract");
    const result = await dispatchUploadExtract(UPLOAD_ID_A);
    expect(result).toBe("inline");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://extract.example.workers.dev"
    );
    expect(trigger).not.toHaveBeenCalled();
    const row = await queryOne<{ status: string }>(
      `SELECT status FROM uploads WHERE id = ?`,
      [UPLOAD_ID_A]
    );
    expect(row?.status).toBe("ready");
  });

  it("sends every upload to the Node worker when WORKER_URL is set", async () => {
    await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text: "The lamps were lit along the quay. ".repeat(4),
    });
    await execute(
      `UPDATE uploads
         SET status = 'uploaded', format = 'txt', byte_size = 80, file_name = 'note.txt'
       WHERE id = ?`,
      [UPLOAD_ID_A]
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 202 })
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env.WORKER_URL = "https://worker.example";
    process.env.EXTRACT_WORKER_URL = "https://extract.example.workers.dev";
    process.env.EXTRACT_WORKER_SECRET = "extract-secret";

    const { dispatchUploadExtract } = await import("@/lib/jobs/dispatch-extract");
    const result = await dispatchUploadExtract(UPLOAD_ID_A);

    expect(result).toBe("node");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://worker.example/extract");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer test-internal-secret",
    });
    expect(JSON.parse(String(init.body))).toEqual({ uploadId: UPLOAD_ID_A });
    const row = await queryOne<{ status: string; extract_host: string }>(
      `SELECT status, extract_host FROM uploads WHERE id = ?`,
      [UPLOAD_ID_A]
    );
    expect(row?.status).toBe("extracting");
    expect(row?.extract_host).toBe("node");
  });

  it("falls back to Cloudflare when the Node worker is unhealthy", async () => {
    await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text: "The lamps were lit along the quay. ".repeat(4),
    });
    await execute(`UPDATE uploads SET status = 'uploaded', byte_size = 6000000, format = 'pdf', file_name = 'book.pdf' WHERE id = ?`, [
      UPLOAD_ID_A,
    ]);
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).startsWith("https://worker.example/")) {
        return new Response(JSON.stringify({ ok: false, error: "Not ready" }), {
          status: 503,
        });
      }
      return new Response(JSON.stringify({ status: "extracting" }), { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.WORKER_URL = "https://worker.example";
    process.env.EXTRACT_WORKER_URL = "https://extract.example.workers.dev";
    process.env.EXTRACT_WORKER_SECRET = "extract-secret";

    const { dispatchUploadExtract } = await import("@/lib/jobs/dispatch-extract");
    const result = await dispatchUploadExtract(UPLOAD_ID_A);

    expect(result).toBe("worker");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://worker.example/extract");
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      "https://extract.example.workers.dev"
    );
    const row = await queryOne<{ extract_host: string }>(
      `SELECT extract_host FROM uploads WHERE id = ?`,
      [UPLOAD_ID_A]
    );
    expect(row?.extract_host).toBe("cloudflare");
  });

  it("hands a legacy extracting row to Node and fails it after the cap", async () => {
    await seedUpload({
      id: UPLOAD_ID_A,
      userId: USER_A,
      text: "The lamps were lit along the quay. ".repeat(4),
    });
    await execute(
      `UPDATE uploads
         SET status = 'extracting', extract_host = NULL, extract_attempts = 0,
             extract_started_at = unixepoch() - 30
       WHERE id = ?`,
      [UPLOAD_ID_A]
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 202 })
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env.WORKER_URL = "https://worker.example";

    const { advanceStuckExtract } = await import("@/lib/jobs/dispatch-extract");
    expect(await advanceStuckExtract(UPLOAD_ID_A)).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://worker.example/extract");

    await execute(
      `UPDATE uploads
         SET status = 'extracting', extract_host = 'node', extract_attempts = 4,
             extract_started_at = unixepoch() - 400,
             extract_accepted_at = unixepoch() - 400
       WHERE id = ?`,
      [UPLOAD_ID_A]
    );
    fetchMock.mockClear();
    expect(await advanceStuckExtract(UPLOAD_ID_A)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const row = await queryOne<{ status: string; error_message: string }>(
      `SELECT status, error_message FROM uploads WHERE id = ?`,
      [UPLOAD_ID_A]
    );
    expect(row?.status).toBe("failed");
    expect(row?.error_message).toBe("This file took too long to read. Try again.");
  });
});
