import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/jobs/route";
import {
  USER_A,
  buildRequest,
  jobRow,
  resetDatabase,
  routeParams,
  uploadBookViaApi,
} from "@/test/harness";

const BOOK = "The lamps were lit along the quay. ".repeat(8);

const DREW_ENV = {
  DREW_ENABLED: "1",
  DREW_URL: "https://example.modal.run",
  DREW_TOKEN: "token",
} as const;

function clearDrewEnv() {
  delete process.env.DREW_ENABLED;
  delete process.env.DREW_URL;
  delete process.env.DREW_TOKEN;
}

describe("plain stock job create", () => {
  beforeEach(async () => {
    await resetDatabase();
    clearDrewEnv();
  });

  afterEach(() => {
    clearDrewEnv();
  });

  it("stores Drew when the request names Expressive (Andrew is retired)", async () => {
    Object.assign(process.env, DREW_ENV);
    const upload = await uploadBookViaApi(BOOK, { userId: USER_A });
    const response = await POST(
      await buildRequest("/api/jobs", {
        userId: USER_A,
        body: {
          mode: "stock",
          jobKind: "stream",
          pdfStoragePath: upload.body.storagePath,
          bookTitle: "Quay",
          catalogVoiceId: "standard-expressive",
          stockDelivery: "expressive",
          ttsProvider: "fish",
          providerVoiceId: "a50f1ee074124ba2b1dc44623f99abbe",
          voiceName: "Andrew (Expressive)",
          ttsOptions: { model: "s2.1-pro-free" },
        },
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const row = await jobRow(body.jobId as string);
    expect(row?.tts_provider).toBe("drew");
    expect(row?.provider_voice_id).toBe("drew");
    expect(row?.catalog_voice_id).toBe("drew");
    expect(row?.voice_name).toBe("Drew");
    const options = JSON.parse(String(row?.tts_options)) as { model?: string };
    expect(options.model).toBe("kokoro/drew");
  });

  it("stores Drew when an old client still names Randolph", async () => {
    Object.assign(process.env, DREW_ENV);
    const upload = await uploadBookViaApi(BOOK, { userId: USER_A });
    const response = await POST(
      await buildRequest("/api/jobs", {
        userId: USER_A,
        body: {
          mode: "stock",
          jobKind: "stream",
          pdfStoragePath: upload.body.storagePath,
          catalogVoiceId: "randolph",
          stockDelivery: "expressive",
          voiceName: "Randolph (Expressive)",
        },
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const row = await jobRow(body.jobId as string);
    expect(row?.tts_provider).toBe("drew");
    expect(row?.provider_voice_id).toBe("drew");
    expect(row?.catalog_voice_id).toBe("drew");
    expect(row?.voice_name).toBe("Drew");
  });

  it("stores Drew when the request names Google Cloud TTS", async () => {
    Object.assign(process.env, DREW_ENV);
    const upload = await uploadBookViaApi(BOOK, { userId: USER_A });
    const response = await POST(
      await buildRequest("/api/jobs", {
        userId: USER_A,
        body: {
          mode: "stock",
          jobKind: "takehome",
          pdfStoragePath: upload.body.storagePath,
          ttsProvider: "google",
          providerVoiceId: "en-GB-Neural2-O",
          voiceName: "Randolph",
        },
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const row = await jobRow(body.jobId as string);
    expect(row?.tts_provider).toBe("drew");
    expect(row?.provider_voice_id).toBe("drew");
    expect(row?.catalog_voice_id).toBe("drew");
    expect(row?.voice_name).toBe("Drew");
  });

  it("defaults a request with no voice to Drew", async () => {
    Object.assign(process.env, DREW_ENV);
    const upload = await uploadBookViaApi(BOOK, { userId: USER_A });
    const response = await POST(
      await buildRequest("/api/jobs", {
        userId: USER_A,
        body: {
          mode: "stock",
          jobKind: "takehome",
          pdfStoragePath: upload.body.storagePath,
          bookTitle: "Quay",
        },
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const row = await jobRow(body.jobId as string);
    expect(row?.catalog_voice_id).toBe("drew");
    expect(row?.tts_provider).toBe("drew");
    expect(row?.provider_voice_id).toBe("drew");
  });

  it("defaults to Ava, not Drew, before Drew's endpoint is configured", async () => {
    const upload = await uploadBookViaApi(BOOK, { userId: USER_A });
    const response = await POST(
      await buildRequest("/api/jobs", {
        userId: USER_A,
        body: {
          mode: "stock",
          jobKind: "takehome",
          pdfStoragePath: upload.body.storagePath,
          bookTitle: "Quay",
        },
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const row = await jobRow(body.jobId as string);
    expect(row?.catalog_voice_id).toBe("ava");
    expect(row?.tts_provider).toBe("edge");
  });

  it("fails closed with 503 when a request names Drew and the endpoint is unset", async () => {
    const upload = await uploadBookViaApi(BOOK, { userId: USER_A });
    const response = await POST(
      await buildRequest("/api/jobs", {
        userId: USER_A,
        body: {
          mode: "stock",
          jobKind: "takehome",
          pdfStoragePath: upload.body.storagePath,
          bookTitle: "Quay",
          catalogVoiceId: "drew",
        },
      })
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("DREW_NOT_CONFIGURED");
  });

  it("stores Drew when a stale client still names Echomancer Andrew", async () => {
    Object.assign(process.env, DREW_ENV);
    const upload = await uploadBookViaApi(BOOK, { userId: USER_A });
    const response = await POST(
      await buildRequest("/api/jobs", {
        userId: USER_A,
        body: {
          mode: "stock",
          jobKind: "takehome",
          pdfStoragePath: upload.body.storagePath,
          bookTitle: "Quay",
          catalogVoiceId: "echomancer-andrew",
          ttsProvider: "paradee",
          providerVoiceId: "paradee-v1.1-int8",
          voiceName: "Echomancer Andrew",
          ttsOptions: { model: "paradee/paradee-v1.1-int8" },
        },
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const row = await jobRow(body.jobId as string);
    expect(row?.tts_provider).toBe("drew");
    expect(row?.provider_voice_id).toBe("drew");
    expect(row?.catalog_voice_id).toBe("drew");
    expect(row?.voice_name).toBe("Drew");
    const options = JSON.parse(String(row?.tts_options)) as { model?: string };
    expect(options.model).toBe("kokoro/drew");
  });

  it("stores Drew when a stale client names Paradee and no catalog id", async () => {
    Object.assign(process.env, DREW_ENV);
    const upload = await uploadBookViaApi(BOOK, { userId: USER_A });
    const response = await POST(
      await buildRequest("/api/jobs", {
        userId: USER_A,
        body: {
          mode: "stock",
          jobKind: "stream",
          pdfStoragePath: upload.body.storagePath,
          ttsProvider: "paradee",
          providerVoiceId: "paradee-v1.1-int8",
          voiceName: "Echomancer Andrew",
        },
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const row = await jobRow(body.jobId as string);
    expect(row?.tts_provider).toBe("drew");
    expect(row?.provider_voice_id).toBe("drew");
    expect(row?.catalog_voice_id).toBe("drew");
    expect(row?.voice_name).toBe("Drew");
  });

  it("fails closed when a Paradee body has no catalog id and Drew is unset", async () => {
    const upload = await uploadBookViaApi(BOOK, { userId: USER_A });
    const response = await POST(
      await buildRequest("/api/jobs", {
        userId: USER_A,
        body: {
          mode: "stock",
          jobKind: "takehome",
          pdfStoragePath: upload.body.storagePath,
          ttsProvider: "paradee",
          providerVoiceId: "paradee-v1.1-int8",
          voiceName: "Echomancer Andrew",
          ttsOptions: { model: "paradee/paradee-v1.1-int8" },
        },
      })
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("DREW_NOT_CONFIGURED");
    const { query } = await import("@/lib/turso");
    const rows = await query<{ id: string }>("SELECT id FROM jobs");
    expect(rows).toHaveLength(0);
  });

  it("fails closed when a request names Echomancer Andrew and Drew is unset", async () => {
    const upload = await uploadBookViaApi(BOOK, { userId: USER_A });
    const response = await POST(
      await buildRequest("/api/jobs", {
        userId: USER_A,
        body: {
          mode: "stock",
          jobKind: "takehome",
          pdfStoragePath: upload.body.storagePath,
          catalogVoiceId: "echomancer-andrew",
          ttsProvider: "paradee",
          providerVoiceId: "paradee-v1.1-int8",
        },
      })
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("DREW_NOT_CONFIGURED");
  });

  it("stores Edge Libby when an old client still names Clara", async () => {
    const upload = await uploadBookViaApi(BOOK, { userId: USER_A });
    const response = await POST(
      await buildRequest("/api/jobs", {
        userId: USER_A,
        body: {
          mode: "stock",
          jobKind: "stream",
          pdfStoragePath: upload.body.storagePath,
          catalogVoiceId: "clara",
          stockDelivery: "expressive",
        },
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const row = await jobRow(body.jobId as string);
    expect(row?.tts_provider).toBe("edge");
    expect(row?.provider_voice_id).toBe("en-GB-LibbyNeural");
    expect(row?.catalog_voice_id).toBe("libby");
    expect(row?.voice_name).toBe("Libby");
  });

  /**
   * The migration contract: a *stored* Andrew row is never rewritten. Only a
   * new request is coerced, and only at insert time. This asserts the row a
   * book already has keeps its Edge provider and `standard` id, so its audio
   * keeps playing and is never re-spoken.
   */
  it("leaves an existing Andrew row exactly as it was stored", async () => {
    const upload = await uploadBookViaApi(BOOK, { userId: USER_A });
    const { execute } = await import("@/lib/turso");
    await execute(
      `INSERT INTO jobs (
         id, user_id, book_title, voice_name, status, progress, pdf_storage_path,
         generation_mode, job_kind, tts_provider, provider_voice_id,
         catalog_voice_id, tts_options, char_count, next_section_index, total_sections
       ) VALUES (?, ?, ?, ?, 'ready', 100, ?, 'stock', 'takehome',
         'edge', 'en-US-AndrewNeural', 'standard', ?, ?, 0, 1)`,
      [
        "job-andrew-stored",
        USER_A,
        "Old book",
        "Andrew",
        upload.body.storagePath,
        JSON.stringify({ model: "edge/en-US-AndrewNeural" }),
        BOOK.length,
      ]
    );

    const row = await jobRow("job-andrew-stored");
    expect(row?.tts_provider).toBe("edge");
    expect(row?.provider_voice_id).toBe("en-US-AndrewNeural");
    expect(row?.catalog_voice_id).toBe("standard");
    expect(row?.voice_name).toBe("Andrew");
    // Nothing about the stored row moved, so its saved audio keeps playing.
    expect(row?.status).toBe("ready");
  });

  /**
   * The same contract for Paradee: a stored Echomancer Andrew row is never
   * rewritten. Only a new request is coerced, and only at insert time.
   */
  it("leaves an existing Echomancer Andrew row exactly as it was stored", async () => {
    const upload = await uploadBookViaApi(BOOK, { userId: USER_A });
    const { execute } = await import("@/lib/turso");
    await execute(
      `INSERT INTO jobs (
         id, user_id, book_title, voice_name, status, progress, pdf_storage_path,
         generation_mode, job_kind, tts_provider, provider_voice_id,
         catalog_voice_id, tts_options, char_count, next_section_index, total_sections
       ) VALUES (?, ?, ?, ?, 'ready', 100, ?, 'stock', 'takehome',
         'paradee', 'paradee-v1.1-int8', 'echomancer-andrew', ?, ?, 0, 1)`,
      [
        "job-echomancer-andrew-stored",
        USER_A,
        "Old book",
        "Echomancer Andrew",
        upload.body.storagePath,
        JSON.stringify({ model: "paradee/paradee-v1.1-int8" }),
        BOOK.length,
      ]
    );

    const row = await jobRow("job-echomancer-andrew-stored");
    expect(row?.tts_provider).toBe("paradee");
    expect(row?.provider_voice_id).toBe("paradee-v1.1-int8");
    expect(row?.catalog_voice_id).toBe("echomancer-andrew");
    expect(row?.voice_name).toBe("Echomancer Andrew");
    expect(row?.status).toBe("ready");
  });

  it("requeues a failed Echomancer Andrew book without changing its voice", async () => {
    const upload = await uploadBookViaApi(BOOK, { userId: USER_A });
    const { execute } = await import("@/lib/turso");
    await execute(
      `INSERT INTO jobs (
         id, user_id, book_title, voice_name, status, progress, pdf_storage_path,
         generation_mode, job_kind, tts_provider, provider_voice_id,
         catalog_voice_id, tts_options, char_count, next_section_index, total_sections,
         segments_json, error_message
       ) VALUES (?, ?, ?, ?, 'failed', 40, ?, 'stock', 'takehome',
         'paradee', 'paradee-v1.1-int8', 'echomancer-andrew', ?, ?, 1, 2, ?, ?)`,
      [
        "job-echomancer-andrew-retry",
        USER_A,
        "Old book",
        "Echomancer Andrew",
        upload.body.storagePath,
        JSON.stringify({ model: "paradee/paradee-v1.1-int8" }),
        BOOK.length,
        JSON.stringify([
          {
            index: 0,
            path: "audiobooks/job-echomancer-andrew-retry/sections/0000.mp3",
            status: "ready",
          },
        ]),
        "Section 1: boom",
      ]
    );

    const { PATCH } = await import("@/app/api/jobs/[id]/route");
    const response = await PATCH(
      await buildRequest("/api/jobs/job-echomancer-andrew-retry", {
        userId: USER_A,
        method: "PATCH",
        body: { action: "retry" },
      }),
      routeParams({ id: "job-echomancer-andrew-retry" })
    );
    expect(response.status).toBe(200);

    const row = await jobRow("job-echomancer-andrew-retry");
    expect(row?.status).toBe("queued");
    expect(row?.next_section_index).toBe(1);
    expect(row?.tts_provider).toBe("paradee");
    expect(row?.provider_voice_id).toBe("paradee-v1.1-int8");
    expect(row?.catalog_voice_id).toBe("echomancer-andrew");
    expect(row?.voice_name).toBe("Echomancer Andrew");
    const options = JSON.parse(String(row?.tts_options)) as { model?: string };
    expect(options.model).toBe("paradee/paradee-v1.1-int8");
  });

  it("copies a stored Echomancer Andrew stream into take-home on Paradee", async () => {
    const upload = await uploadBookViaApi(BOOK, { userId: USER_A });
    const { execute } = await import("@/lib/turso");
    await execute(
      `INSERT INTO jobs (
         id, user_id, book_title, voice_name, status, progress, pdf_storage_path,
         generation_mode, job_kind, tts_provider, provider_voice_id,
         catalog_voice_id, tts_options, char_count, next_section_index
       ) VALUES (?, ?, ?, ?, 'ready', 100, ?, 'stock', 'stream',
         'paradee', 'paradee-v1.1-int8', 'echomancer-andrew', ?, ?, 0)`,
      [
        "job-echomancer-andrew-stream",
        USER_A,
        "Old book",
        "Echomancer Andrew",
        upload.body.storagePath,
        JSON.stringify({ model: "paradee/paradee-v1.1-int8" }),
        BOOK.length,
      ]
    );

    const { POST: takehome } = await import("@/app/api/jobs/[id]/takehome/route");
    const response = await takehome(
      await buildRequest("/api/jobs/job-echomancer-andrew-stream/takehome", {
        userId: USER_A,
        method: "POST",
      }),
      routeParams({ id: "job-echomancer-andrew-stream" })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { jobId?: string };
    const child = await jobRow(String(body.jobId));
    expect(child?.tts_provider).toBe("paradee");
    expect(child?.provider_voice_id).toBe("paradee-v1.1-int8");
    expect(child?.catalog_voice_id).toBe("echomancer-andrew");
    expect(child?.voice_name).toBe("Echomancer Andrew");
    const parent = await jobRow("job-echomancer-andrew-stream");
    expect(parent?.catalog_voice_id).toBe("echomancer-andrew");
    expect(parent?.tts_provider).toBe("paradee");
  });
});
