import { beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/jobs/route";
import {
  USER_A,
  buildRequest,
  jobRow,
  resetDatabase,
  uploadBookViaApi,
} from "@/test/harness";

const BOOK = "The lamps were lit along the quay. ".repeat(8);

describe("plain stock job create", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("stores Edge Andrew when the request names Expressive", async () => {
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
    expect(row?.tts_provider).toBe("edge");
    expect(row?.provider_voice_id).toBe("en-US-AndrewNeural");
    expect(row?.catalog_voice_id).toBe("standard");
    expect(row?.voice_name).toBe("Andrew");
    const options = JSON.parse(String(row?.tts_options)) as { model?: string };
    expect(options.model).toBe("edge/en-US-AndrewNeural");
  });

  it("stores Edge Andrew when an old client still names Randolph", async () => {
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
    expect(row?.tts_provider).toBe("edge");
    expect(row?.provider_voice_id).toBe("en-US-AndrewNeural");
    expect(row?.catalog_voice_id).toBe("standard");
    expect(row?.voice_name).toBe("Andrew");
  });

  it("stores Edge Andrew when the request names Google Cloud TTS", async () => {
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
    expect(row?.tts_provider).toBe("edge");
    expect(row?.provider_voice_id).toBe("en-US-AndrewNeural");
    expect(row?.catalog_voice_id).toBe("standard");
    expect(row?.voice_name).toBe("Andrew");
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
});
