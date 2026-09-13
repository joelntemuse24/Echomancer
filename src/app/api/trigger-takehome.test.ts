/**
 * Whole-book enqueue must fire Trigger `takehome.advance` and must not synth.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  USER_A,
  buildRequest,
  createFakeProvider,
  jobRow,
  resetDatabase,
  routeParams,
  uploadBookViaApi,
} from "@/test/harness";
import { execute, queryOne } from "@/lib/turso";

const trigger = vi.fn().mockResolvedValue({ id: "run_test" });
const restFetch = vi.fn().mockResolvedValue({
  ok: false,
  status: 401,
  statusText: "Unauthorized",
  text: async () => "unauthorized",
});

vi.mock("@trigger.dev/sdk", () => ({
  configure: vi.fn(),
  tasks: {
    trigger: (...args: unknown[]) => trigger(...args),
  },
}));

const BOOK = "The lamps were lit along the quay. ".repeat(40);

async function uploadBook() {
  return uploadBookViaApi(BOOK, { userId: USER_A });
}

async function putPendingBook() {
  const bytes = Buffer.from(BOOK, "utf-8");
  const { POST: presign } = await import("@/app/api/pdf/upload/route");
  const presignRes = await presign(
    await buildRequest("/api/pdf/upload", {
      userId: USER_A,
      body: {
        fileName: "book.txt",
        contentType: "text/plain",
        byteSize: bytes.length,
      },
    })
  );
  const presignBody = await presignRes.json();
  const { PUT } = await import("@/app/api/pdf/upload/[id]/object/route");
  await PUT(
    await buildRequest(presignBody.putUrl, {
      method: "PUT",
      userId: USER_A,
      headers: presignBody.putHeaders,
      rawBody: bytes,
    }),
    routeParams({ id: presignBody.uploadId })
  );
  return { uploadId: presignBody.uploadId as string };
}

async function pollUpload(uploadId: string) {
  const { GET } = await import("@/app/api/pdf/upload/[id]/route");
  return GET(
    await buildRequest(`/api/pdf/upload/${uploadId}`, {
      userId: USER_A,
      method: "GET",
    }),
    routeParams({ id: uploadId })
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  trigger.mockReset();
  trigger.mockResolvedValue({ id: "run_test" });
  restFetch.mockReset();
  restFetch.mockResolvedValue({
    ok: false,
    status: 401,
    statusText: "Unauthorized",
    text: async () => "unauthorized",
  });
  vi.stubGlobal("fetch", restFetch);
  process.env.TRIGGER_SECRET_KEY = "tr_test_secret";
  delete process.env.VERCEL_ENV;
  await resetDatabase();
  const providers = await import("@/lib/tts/providers");
  vi.spyOn(providers, "resolveStockAdapter").mockReturnValue(
    createFakeProvider()
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("document extract Trigger dispatch", () => {
  it("POST /api/pdf/upload/:id complete enqueues upload.extract once and does not extract", async () => {
    const extract = await import("@/lib/text-extraction");
    const spy = vi.spyOn(extract, "extractTextFromDocument");
    const { uploadId } = await putPendingBook();

    trigger.mockClear();
    const { POST: complete } = await import("@/app/api/pdf/upload/[id]/route");
    const completeRes = await complete(
      await buildRequest(`/api/pdf/upload/${uploadId}`, {
        userId: USER_A,
        body: {},
      }),
      routeParams({ id: uploadId })
    );
    const completeBody = await completeRes.json();

    expect(completeRes.status).toBe(200);
    expect(completeBody.status).not.toBe("ready");
    expect(spy).not.toHaveBeenCalled();
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith(
      "upload.extract",
      { uploadId },
      { concurrencyKey: uploadId }
    );
    const row = await queryOne<{ extract_started_at: number | null }>(
      `SELECT extract_started_at FROM uploads WHERE id = ?`,
      [uploadId]
    );
    expect(Number(row?.extract_started_at)).toBeGreaterThan(0);
  });

  it("POST /api/pdf/upload/:id complete is 503 when Trigger returns no run", async () => {
    trigger.mockResolvedValue({});
    const { uploadId } = await putPendingBook();

    const { POST: complete } = await import("@/app/api/pdf/upload/[id]/route");
    const completeRes = await complete(
      await buildRequest(`/api/pdf/upload/${uploadId}`, {
        userId: USER_A,
        body: {},
      }),
      routeParams({ id: uploadId })
    );
    const completeBody = await completeRes.json();

    expect(completeRes.status).toBe(503);
    expect(completeBody.code).toBe("TRIGGER_DISPATCH_FAILED");
    expect(String(completeBody.error)).toMatch(/could not be started/i);
    expect(restFetch).toHaveBeenCalled();
  });

  it("GET /api/pdf/upload/:id does not re-enqueue on rapid polls after complete", async () => {
    const { uploadId } = await putPendingBook();
    const { POST: complete } = await import("@/app/api/pdf/upload/[id]/route");
    await complete(
      await buildRequest(`/api/pdf/upload/${uploadId}`, {
        userId: USER_A,
        body: {},
      }),
      routeParams({ id: uploadId })
    );

    trigger.mockClear();
    for (let i = 0; i < 3; i++) {
      const poll = await pollUpload(uploadId);
      expect(poll.status).toBe(200);
      expect((await poll.json()).status).toBe("uploaded");
    }
    expect(trigger).not.toHaveBeenCalled();
  });

  it("GET /api/pdf/upload/:id re-enqueues once when uploaded stays stuck past the threshold", async () => {
    const { uploadId } = await putPendingBook();
    const { POST: complete } = await import("@/app/api/pdf/upload/[id]/route");
    await complete(
      await buildRequest(`/api/pdf/upload/${uploadId}`, {
        userId: USER_A,
        body: {},
      }),
      routeParams({ id: uploadId })
    );

    await execute(
      `UPDATE uploads SET extract_started_at = unixepoch() - 20 WHERE id = ?`,
      [uploadId]
    );

    trigger.mockClear();
    const first = await pollUpload(uploadId);
    expect(first.status).toBe(200);
    expect((await first.json()).status).toBe("uploaded");
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith(
      "upload.extract",
      { uploadId },
      { concurrencyKey: uploadId }
    );

    trigger.mockClear();
    const second = await pollUpload(uploadId);
    expect(second.status).toBe(200);
    expect(trigger).not.toHaveBeenCalled();
  });
});

describe("take-home Trigger dispatch", () => {
  it("POST /api/jobs takehome emits tasks.trigger and does not synthesize", async () => {
    const upload = await uploadBook();
    const { POST } = await import("@/app/api/jobs/route");
    const response = await POST(
      await buildRequest("/api/jobs", {
        userId: USER_A,
        body: {
          mode: "stock",
          jobKind: "takehome",
          pdfStoragePath: upload.body.storagePath,
          bookTitle: "The Quay",
        },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("queued");
    expect(trigger).toHaveBeenCalledWith(
      "takehome.advance",
      { jobId: body.jobId },
      { concurrencyKey: body.jobId }
    );
    const providers = await import("@/lib/tts/providers");
    expect(providers.resolveStockAdapter).not.toHaveBeenCalled();
  });

  it("persists Whole-book narration delivery overrides on the job", async () => {
    const upload = await uploadBook();
    const { POST } = await import("@/app/api/jobs/route");
    const response = await POST(
      await buildRequest("/api/jobs", {
        userId: USER_A,
        body: {
          mode: "stock",
          jobKind: "takehome",
          pdfStoragePath: upload.body.storagePath,
          bookTitle: "The Quay",
          ttsOptions: {
            pauseStyle: "sparse",
            crossfadeMs: 80,
            normalizeTitles: false,
            deliveryPrefix: false,
          },
        },
      })
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    const row = await jobRow(body.jobId);
    const options = JSON.parse(String(row?.tts_options || "{}")) as {
      pauseStyle?: string;
      crossfadeMs?: number;
      normalizeTitles?: boolean;
      deliveryPrefix?: boolean;
    };
    expect(options.pauseStyle).toBe("sparse");
    expect(options.crossfadeMs).toBe(80);
    expect(options.normalizeTitles).toBe(false);
    expect(options.deliveryPrefix).toBe(false);
  });

  it("POST /api/jobs/[id]/takehome emits tasks.trigger", async () => {
    const upload = await uploadBook();
    const { POST: create } = await import("@/app/api/jobs/route");
    const stream = await create(
      await buildRequest("/api/jobs", {
        userId: USER_A,
        body: {
          mode: "stock",
          jobKind: "stream",
          pdfStoragePath: upload.body.storagePath,
          bookTitle: "The Quay",
        },
      })
    );
    const streamBody = await stream.json();
    trigger.mockClear();

    const { POST } = await import("@/app/api/jobs/[id]/takehome/route");
    const response = await POST(
      await buildRequest(`/api/jobs/${streamBody.jobId}/takehome`, {
        userId: USER_A,
        method: "POST",
      }),
      routeParams({ id: streamBody.jobId })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(trigger).toHaveBeenCalledWith(
      "takehome.advance",
      { jobId: body.jobId },
      { concurrencyKey: body.jobId }
    );
  });

  it("PATCH retry emits tasks.trigger and keeps ready sections", async () => {
    const upload = await uploadBook();
    const { POST: create } = await import("@/app/api/jobs/route");
    const created = await create(
      await buildRequest("/api/jobs", {
        userId: USER_A,
        body: {
          mode: "stock",
          jobKind: "takehome",
          pdfStoragePath: upload.body.storagePath,
          bookTitle: "The Quay",
        },
      })
    );
    const jobId = (await created.json()).jobId as string;

    const { execute } = await import("@/lib/turso");
    await execute(
      `UPDATE jobs SET status = 'failed', total_sections = 4,
         next_section_index = 2,
         segments_json = ?,
         error_message = 'Section 2: boom'
       WHERE id = ?`,
      [
        JSON.stringify([
          { index: 0, path: "audiobooks/x/sections/0000.mp3", status: "ready" },
          { index: 1, path: "audiobooks/x/sections/0001.mp3", status: "ready" },
        ]),
        jobId,
      ]
    );
    trigger.mockClear();

    const { PATCH } = await import("@/app/api/jobs/[id]/route");
    const response = await PATCH(
      await buildRequest(`/api/jobs/${jobId}`, {
        userId: USER_A,
        method: "PATCH",
        body: { action: "retry" },
      }),
      routeParams({ id: jobId })
    );

    expect(response.status).toBe(200);
    expect(trigger).toHaveBeenCalledWith(
      "takehome.advance",
      { jobId },
      { concurrencyKey: jobId }
    );

    const row = await jobRow(jobId);
    expect(row?.status).toBe("queued");
    expect(row?.next_section_index).toBe(2);
    const segments = JSON.parse(String(row?.segments_json)) as Array<{
      index: number;
    }>;
    expect(segments.map((s) => s.index)).toEqual([0, 1]);
  });

  it("POST /api/jobs takehome without TRIGGER_SECRET_KEY in production is 503", async () => {
    const upload = await uploadBook();
    delete process.env.TRIGGER_SECRET_KEY;
    process.env.VERCEL_ENV = "production";
    trigger.mockClear();
    const { POST } = await import("@/app/api/jobs/route");
    const response = await POST(
      await buildRequest("/api/jobs", {
        userId: USER_A,
        body: {
          mode: "stock",
          jobKind: "takehome",
          pdfStoragePath: upload.body.storagePath,
          bookTitle: "The Quay",
        },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.code).toBe("TRIGGER_NOT_CONFIGURED");
    expect(String(body.error)).toMatch(/TRIGGER_SECRET_KEY/);
    expect(body.error).not.toBe("Internal server error");
    expect(trigger).not.toHaveBeenCalled();

    const { query } = await import("@/lib/turso");
    const jobs = await query<{ id: string }>(
      `SELECT id FROM jobs WHERE job_kind = 'takehome'`
    );
    expect(jobs).toHaveLength(0);
  });

  it("leaves a take-home queued when Trigger dispatch fails after insert", async () => {
    const upload = await uploadBook();
    trigger.mockRejectedValueOnce(new Error("Trigger API unavailable"));
    const { POST } = await import("@/app/api/jobs/route");
    const response = await POST(
      await buildRequest("/api/jobs", {
        userId: USER_A,
        body: {
          mode: "stock",
          jobKind: "takehome",
          pdfStoragePath: upload.body.storagePath,
          bookTitle: "The Quay",
        },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("queued");
    expect(body.jobId).toBeTruthy();
    expect(body.error).toBeUndefined();

    const row = await jobRow(body.jobId as string);
    expect(row?.status).toBe("queued");
  });
});
