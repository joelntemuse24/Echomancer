import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/jobs/route";
import {
  USER_A,
  buildRequest,
  jobRow,
  resetDatabase,
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
});
