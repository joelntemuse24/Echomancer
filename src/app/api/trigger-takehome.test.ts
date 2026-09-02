/**
 * Whole-book enqueue must fire Trigger `takehome.advance` and must not synth.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  USER_A,
  buildRequest,
  createFakeProvider,
  jobRow,
  resetDatabase,
  routeParams,
} from "@/test/harness";

const trigger = vi.fn().mockResolvedValue({ id: "run_test" });

vi.mock("@trigger.dev/sdk", () => ({
  tasks: {
    trigger: (...args: unknown[]) => trigger(...args),
  },
}));

const BOOK = "The lamps were lit along the quay. ".repeat(40);

async function uploadBook() {
  const { POST } = await import("@/app/api/pdf/upload/route");
  const formData = new FormData();
  formData.append(
    "file",
    new File([BOOK], "book.txt", { type: "text/plain" }),
    "book.txt"
  );
  const response = await POST(
    await buildRequest("/api/pdf/upload", {
      method: "POST",
      formData,
      userId: USER_A,
    })
  );
  return { response, body: await response.json() };
}

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.TRIGGER_SECRET_KEY = "tr_test_secret";
  await resetDatabase();
  const providers = await import("@/lib/tts/providers");
  vi.spyOn(providers, "resolveStockAdapter").mockReturnValue(
    createFakeProvider()
  );
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
});
