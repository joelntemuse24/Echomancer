import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/jobs/route";
import {
  FISH_TWIN_GATE_ENV,
  FISH_TWIN_REF_ENV,
} from "@/lib/tts/fish-stock-twins";
import {
  USER_A,
  buildRequest,
  jobRow,
  resetDatabase,
  uploadBookViaApi,
} from "@/test/harness";

const SAMPLE_REF = "a50f1ee074124ba2b1dc44623f99abbe";
const BOOK = "The lamps were lit along the quay. ".repeat(8);

function clearTwinEnv() {
  for (const key of Object.values(FISH_TWIN_GATE_ENV)) delete process.env[key];
  for (const key of Object.values(FISH_TWIN_REF_ENV)) delete process.env[key];
}

describe("job create fish twins", () => {
  beforeEach(async () => {
    clearTwinEnv();
    await resetDatabase();
  });

  afterEach(() => {
    clearTwinEnv();
  });

  it("stores Edge for Standard while the twin gate is closed", async () => {
    const upload = await uploadBookViaApi(BOOK, {
      userId: USER_A,
    });
    const response = await POST(
      await buildRequest("/api/jobs", {
        userId: USER_A,
        body: {
          mode: "stock",
          jobKind: "stream",
          pdfStoragePath: upload.body.storagePath,
          bookTitle: "Quay",
          catalogVoiceId: "standard",
          ttsProvider: "fish",
          providerVoiceId: SAMPLE_REF,
        },
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const row = await jobRow(body.jobId as string);
    expect(row?.tts_provider).toBe("edge");
    expect(row?.provider_voice_id).toBe("en-US-AndrewNeural");
  });

  it("stores Fish for Standard when the gate is open, even if the caller sends Edge", async () => {
    process.env.FISH_TWIN_STANDARD = "1";
    process.env.FISH_TWIN_STANDARD_REF = SAMPLE_REF;
    const upload = await uploadBookViaApi(BOOK, {
      userId: USER_A,
    });
    const response = await POST(
      await buildRequest("/api/jobs", {
        userId: USER_A,
        body: {
          mode: "stock",
          jobKind: "stream",
          pdfStoragePath: upload.body.storagePath,
          bookTitle: "Quay",
          catalogVoiceId: "standard",
          ttsProvider: "edge",
          providerVoiceId: "en-US-AndrewNeural",
          ttsOptions: { model: "edge/en-US-AndrewNeural" },
        },
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const row = await jobRow(body.jobId as string);
    expect(row?.tts_provider).toBe("fish");
    expect(row?.provider_voice_id).toBe(SAMPLE_REF);
    expect(row?.catalog_voice_id).toBe("standard");
    const options = JSON.parse(String(row?.tts_options)) as { model?: string };
    expect(options.model).toBe("s2.1-pro-free");
  });
});
