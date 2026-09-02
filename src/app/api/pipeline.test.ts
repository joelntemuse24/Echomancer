/**
 * End-to-end pipeline: upload → create → worker → ready → download.
 *
 * Runs the real route handlers against an in-memory database and a temp
 * directory; only the speech provider is faked. This is the coverage the audit
 * called out as missing — every previous test exercised pure helpers, so nothing
 * would have caught a break in the wiring between them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  USER_A,
  buildRequest,
  createFakeProvider,
  emptyWav,
  fakeMp3,
  jobRow,
  resetDatabase,
  routeParams,
  uploadBookViaApi,
} from "@/test/harness";
import type { SynthesizeResult } from "@/lib/tts/types";

const INTERNAL = { "x-internal-secret": "test-internal-secret" };

/** A book long enough to split into several sections. */
const BOOK_TEXT = "The lamps were lit along the quay. ".repeat(400);

async function uploadBook(
  text = BOOK_TEXT,
  opts: { userId?: string | null } = { userId: USER_A }
) {
  return uploadBookViaApi(text, opts);
}

async function createJob(opts: {
  userId: string;
  pdfStoragePath: string;
  jobKind?: "stream" | "takehome";
  catalogVoiceId?: string;
}) {
  const { POST } = await import("@/app/api/jobs/route");
  const response = await POST(
    await buildRequest("/api/jobs", {
      userId: opts.userId,
      body: {
        mode: "stock",
        jobKind: opts.jobKind ?? "takehome",
        pdfStoragePath: opts.pdfStoragePath,
        bookTitle: "The Quay",
        ...(opts.catalogVoiceId ? { catalogVoiceId: opts.catalogVoiceId } : {}),
      },
    })
  );
  return { response, body: await response.json() };
}

async function runWorker(jobId: string) {
  const { POST } = await import("@/app/api/jobs/[id]/process/route");
  return POST(
    await buildRequest(`/api/jobs/${jobId}/process`, {
      method: "POST",
      headers: INTERNAL,
    }),
    routeParams({ id: jobId })
  );
}

async function useFakeProvider(
  respond?: (input: unknown, index: number) => SynthesizeResult
) {
  const providers = await import("@/lib/tts/providers");
  const fake = createFakeProvider(
    respond as Parameters<typeof createFakeProvider>[0]
  );
  vi.spyOn(providers, "resolveStockAdapter").mockReturnValue(fake);
  return fake;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetDatabase();
  delete process.env.PREMIUM_HD_ENABLED;
  process.env.TTS_SECTIONS_PER_TICK = "3";
});

describe("upload", () => {
  it("stores the extracted text, records ownership, and issues a session", async () => {
    const { response, body } = await uploadBook(BOOK_TEXT, { userId: null });

    expect(response.status).toBe(200);
    expect(body.storagePath).toMatch(/^pdfs\/[0-9a-f-]{36}\/content\.txt$/);
    expect(body.charCount).toBeGreaterThan(1000);

    const { queryOne } = await import("@/lib/turso");
    const upload = await queryOne<{ user_id: string; char_count: number }>(
      `SELECT user_id, char_count FROM uploads WHERE storage_path = ?`,
      [body.storagePath]
    );
    expect(upload?.user_id).toMatch(/^anon_/);
    expect(upload?.char_count).toBe(body.charCount);

    const { downloadFile } = await import("@/lib/storage");
    const stored = await downloadFile(body.storagePath as string);
    expect(stored.toString("utf-8")).toContain("lamps were lit");
  });

  it("rejects a document with too little extractable text", async () => {
    const { response, body } = await uploadBook("hi");
    expect(response.status).toBe(400);
    expect(body.code).toBe("EXTRACTION_FAILED");
  });

  it("rejects an upload over the configured size cap at presign", async () => {
    const previous = process.env.MAX_UPLOAD_MB;
    process.env.MAX_UPLOAD_MB = "0.001";
    try {
      const { POST } = await import("@/app/api/pdf/upload/route");
      const response = await POST(
        await buildRequest("/api/pdf/upload", {
          userId: USER_A,
          body: {
            fileName: "book.txt",
            contentType: "text/plain",
            byteSize: 2000,
          },
        })
      );
      expect(response.status).toBe(413);
      const body = await response.json();
      expect(body.code).toBe("FILE_TOO_LARGE");
    } finally {
      if (previous === undefined) delete process.env.MAX_UPLOAD_MB;
      else process.env.MAX_UPLOAD_MB = previous;
    }
  });
});

describe("paste text", () => {
  it("stores pasted text as content.txt with ownership", async () => {
    const { POST } = await import("@/app/api/text/upload/route");
    const text = "The lamps were lit along the quay. ".repeat(20);
    const response = await POST(
      await buildRequest("/api/text/upload", {
        method: "POST",
        userId: null,
        body: { text, title: "Quay notes" },
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.source).toBe("paste");
    expect(body.fileName).toBe("Quay notes");
    expect(body.storagePath).toMatch(/^pdfs\/[0-9a-f-]{36}\/content\.txt$/);
    expect(body.charCount).toBe(text.trim().length);
    expect(response.cookies.get("ec_session")?.value).toBeTruthy();

    const { downloadFile } = await import("@/lib/storage");
    const stored = await downloadFile(body.storagePath);
    expect(stored.toString("utf-8")).toContain("lamps were lit");
  });

  it("rejects short paste", async () => {
    const { POST } = await import("@/app/api/text/upload/route");
    const response = await POST(
      await buildRequest("/api/text/upload", {
        method: "POST",
        body: { text: "too short" },
      })
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.code).toBe("EMPTY_TEXT");
  });
});

describe("take-home generation", () => {
  it("carries a book from upload to a downloadable audiobook", async () => {
    const upload = await uploadBook();
    const fake = await useFakeProvider();

    const created = await createJob({
      userId: USER_A,
      pdfStoragePath: upload.body.storagePath,
    });
    expect(created.response.status).toBe(200);
    expect(created.body.status).toBe("queued");
    expect(created.body.priceEstimate.suggestedPriceEur).toBeGreaterThan(0);

    // Creating a job must not synthesize: that used to block the request for
    // tens of seconds and risk a gateway timeout.
    expect(fake.calls).toHaveLength(0);

    const jobId = created.body.jobId as string;
    expect((await runWorker(jobId)).status).toBe(200);

    const finished = await jobRow(jobId);
    expect(finished?.status).toBe("ready");
    expect(finished?.progress).toBe(100);
    expect(fake.calls.length).toBeGreaterThan(1);

    // The lease is surrendered when the job finishes.
    expect(finished?.processing_lease_token).toBeNull();

    const segments = JSON.parse(String(finished?.segments_json)) as Array<{
      index: number;
      status: string;
      path: string;
    }>;
    expect(segments.length).toBe(finished?.total_sections);
    expect(segments.every((s) => s.status === "ready")).toBe(true);

    // A single assembled artifact, not a section path.
    expect(String(finished?.audio_storage_path)).toMatch(
      new RegExp(`^audiobooks/${jobId}/full\\.`)
    );

    const { GET: download } = await import(
      "@/app/api/jobs/[id]/download/route"
    );
    const downloaded = await download(
      await buildRequest(`/api/jobs/${jobId}/download`, { userId: USER_A }),
      routeParams({ id: jobId })
    );
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-disposition")).toContain(
      "the_quay"
    );
    expect(Number(downloaded.headers.get("content-length"))).toBeGreaterThan(
      2048
    );
  });

  it("reports progress and ready sections while still generating", async () => {
    const upload = await uploadBook();
    await useFakeProvider();
    process.env.TTS_SECTIONS_PER_TICK = "1";

    const created = await createJob({
      userId: USER_A,
      pdfStoragePath: upload.body.storagePath,
    });
    const jobId = created.body.jobId as string;

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    const first = await processTakehomeTick(jobId, { sectionsPerTick: 1 });
    expect(first.done).toBe(false);
    expect(first.nextIndex).toBe(1);

    const { GET } = await import("@/app/api/jobs/[id]/route");
    const detail = await GET(
      await buildRequest(`/api/jobs/${jobId}`, { userId: USER_A }),
      routeParams({ id: jobId })
    );
    const job = (await detail.json()).job;

    expect(job.status).toBe("queued");
    expect(job.progress).toBeGreaterThan(0);
    expect(job.segments).toHaveLength(1);
    // Internal fields must never reach the browser.
    expect(job.pdf_storage_path).toBeUndefined();
    expect(job.tts_options).toBeUndefined();
    expect(job.processing_lease_token).toBeUndefined();
  });

  it("resumes an unfinished job on the next worker pass", async () => {
    const upload = await uploadBook();
    const fake = await useFakeProvider();
    const created = await createJob({
      userId: USER_A,
      pdfStoragePath: upload.body.storagePath,
    });
    const jobId = created.body.jobId as string;

    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(jobId, { sectionsPerTick: 1 });
    const afterFirst = await jobRow(jobId);
    expect(afterFirst?.status).toBe("queued");
    const callsAfterFirst = fake.calls.length;

    await runWorker(jobId);
    const afterWorker = await jobRow(jobId);
    expect(afterWorker?.status).toBe("ready");
    // It picked up from the cursor rather than re-synthesizing section 0.
    expect(fake.calls.length).toBeGreaterThan(callsAfterFirst);
    expect(fake.calls.length).toBe(Number(afterWorker?.total_sections));
  });
});

describe("cron drain", () => {
  it("finishes a queued job with nobody watching the page", async () => {
    const upload = await uploadBook();
    await useFakeProvider();
    const created = await createJob({
      userId: USER_A,
      pdfStoragePath: upload.body.storagePath,
    });
    const jobId = created.body.jobId as string;

    const { GET } = await import("@/app/api/cron/process-jobs/route");
    const response = await GET(
      await buildRequest("/api/cron/process-jobs", {
        headers: { authorization: "Bearer test-cron-secret" },
      })
    );

    expect(response.status).toBe(200);
    expect((await response.json()).picked).toBe(1);
    expect((await jobRow(jobId))?.status).toBe("ready");
  });
});

describe("silent provider responses", () => {
  it("retries a silent section and fails the job rather than storing silence", async () => {
    const upload = await uploadBook();
    const fake = await useFakeProvider(() => ({
      audio: emptyWav(),
      contentType: "audio/wav",
    }));

    const created = await createJob({
      userId: USER_A,
      pdfStoragePath: upload.body.storagePath,
    });
    const jobId = created.body.jobId as string;
    await runWorker(jobId);

    const failed = await jobRow(jobId);
    expect(failed?.status).toBe("failed");
    expect(String(failed?.error_message)).toContain("silent audio");
    // Nothing was stored, so the user is not handed a book full of gaps.
    expect(failed?.segments_json).toBeFalsy();
    // It tried more than once before giving up.
    expect(fake.calls.length).toBeGreaterThan(1);
  });

  it("accepts audio once a retry returns real bytes", async () => {
    const upload = await uploadBook();
    await useFakeProvider((_input, index) =>
      index === 0
        ? { audio: emptyWav(), contentType: "audio/wav" }
        : { audio: fakeMp3(), contentType: "audio/mpeg" }
    );

    const created = await createJob({
      userId: USER_A,
      pdfStoragePath: upload.body.storagePath,
    });
    const jobId = created.body.jobId as string;
    await runWorker(jobId);

    const finished = await jobRow(jobId);
    expect(finished?.status).toBe("ready");
  });

  it("treats an all-zero buffer as silence even when it is large", async () => {
    const upload = await uploadBook();
    await useFakeProvider(() => ({
      audio: Buffer.alloc(64_000),
      contentType: "audio/mpeg",
    }));

    const created = await createJob({
      userId: USER_A,
      pdfStoragePath: upload.body.storagePath,
    });
    const jobId = created.body.jobId as string;
    await runWorker(jobId);

    expect((await jobRow(jobId))?.status).toBe("failed");
  });
});

describe("premium HD gate", () => {
  it("refuses to create a job with an HD narrator while the gate is off", async () => {
    const upload = await uploadBook();
    const catalog = await import("@/lib/tts/catalog");
    vi.spyOn(catalog, "getCatalogVoice").mockResolvedValue({
      id: "or:minimax/speech-02-hd:English_CalmWoman",
      provider: "openrouter",
      providerVoiceId: "English_CalmWoman",
      displayName: "Calm Woman",
      language: "English",
      locale: "en-US",
      gender: "female",
      style: "calm",
      tags: ["hd"],
      latencyClass: "quality",
      model: "minimax/speech-02-hd",
      recommendedForLongForm: true,
      supportsNativeStream: false,
      maxCharsPerRequest: 2000,
    });

    const created = await createJob({
      userId: USER_A,
      pdfStoragePath: upload.body.storagePath,
      catalogVoiceId: "or:minimax/speech-02-hd:English_CalmWoman",
    });

    expect(created.response.status).toBe(403);
    expect(created.body.error).toContain("premium");
  });

  it("allows the same narrator once the gate is enabled", async () => {
    process.env.PREMIUM_HD_ENABLED = "true";
    const upload = await uploadBook();
    const catalog = await import("@/lib/tts/catalog");
    vi.spyOn(catalog, "getCatalogVoice").mockResolvedValue({
      id: "or:minimax/speech-02-hd:English_CalmWoman",
      provider: "openrouter",
      providerVoiceId: "English_CalmWoman",
      displayName: "Calm Woman",
      language: "English",
      locale: "en-US",
      gender: "female",
      style: "calm",
      tags: ["hd"],
      latencyClass: "quality",
      model: "minimax/speech-02-hd",
      recommendedForLongForm: true,
      supportsNativeStream: false,
      maxCharsPerRequest: 2000,
    });

    const created = await createJob({
      userId: USER_A,
      pdfStoragePath: upload.body.storagePath,
      catalogVoiceId: "or:minimax/speech-02-hd:English_CalmWoman",
    });

    expect(created.response.status).toBe(200);
  });
});
