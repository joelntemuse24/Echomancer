import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/jobs/route";
import {
  FISH_TWIN_GATE_ENV,
  FISH_TWIN_REF_ENV,
} from "@/lib/tts/fish-stock-twins";
import { execute } from "@/lib/turso";
import {
  USER_A,
  buildRequest,
  createFakeProvider,
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

  it("keeps Standard on Edge when the gate is open unless Expressive is chosen", async () => {
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
          ttsProvider: "fish",
          providerVoiceId: SAMPLE_REF,
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
    const options = JSON.parse(String(row?.tts_options)) as {
      model?: string;
      stockDelivery?: string;
    };
    expect(options.model).toBe("edge/en-US-AndrewNeural");
    expect(options.stockDelivery).toBe("standard");
  });

  it("stores Fish and cue-markup routing when Expressive is selected and the twin is live", async () => {
    process.env.FISH_TWIN_STANDARD = "1";
    process.env.FISH_TWIN_STANDARD_REF = SAMPLE_REF;
    const upload = await uploadBookViaApi(
      `Chapter One\n\nThe harbor was quiet after the rain. She said, "We leave at dawn."\n`,
      { userId: USER_A }
    );
    const response = await POST(
      await buildRequest("/api/jobs", {
        userId: USER_A,
        body: {
          mode: "stock",
          jobKind: "takehome",
          pdfStoragePath: upload.body.storagePath,
          bookTitle: "Harbor",
          catalogVoiceId: "standard",
          stockDelivery: "expressive",
          ttsProvider: "edge",
          providerVoiceId: "en-US-AndrewNeural",
          voiceName: "Standard",
        },
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const row = await jobRow(body.jobId as string);
    expect(row?.tts_provider).toBe("fish");
    expect(row?.provider_voice_id).toBe(SAMPLE_REF);
    expect(row?.catalog_voice_id).toBe("standard");
    expect(row?.voice_name).toBe("Andrew (Expressive)");
    const options = JSON.parse(String(row?.tts_options)) as {
      model?: string;
      stockDelivery?: string;
    };
    expect(options.model).toBe("s2.1-pro-free");
    expect(options.stockDelivery).toBe("expressive");

    const providers = await import("@/lib/tts/providers");
    const tagger = await import("@/lib/tts/fish-cue-tagger");
    const tagSpy = vi.spyOn(tagger, "tagFishCuesForSpeakable");
    const fake = createFakeProvider();
    fake.id = "fish";
    vi.spyOn(providers, "resolveStockAdapter").mockReturnValue(fake);
    const { processTakehomeTick } = await import("@/lib/tts/process-job");
    await processTakehomeTick(body.jobId as string);
    expect(tagSpy).toHaveBeenCalled();
    expect(tagSpy.mock.calls[0]?.[1]).not.toMatchObject({
      delivery: "expressive",
    });
    expect(fake.calls.length).toBeGreaterThan(0);
    expect(fake.calls.every((call) => call.voiceId === SAMPLE_REF)).toBe(true);
    expect(
      fake.calls.some((call) => /\[confident\]/.test(call.text))
    ).toBe(true);
    expect(fake.calls.every((call) => !/\[soft tone\]/.test(call.text))).toBe(
      true
    );
  });

  it("rejects Expressive when the gate is closed and for Clara", async () => {
    process.env.FISH_TWIN_RANDOLPH_REF = SAMPLE_REF;
    const upload = await uploadBookViaApi(BOOK, { userId: USER_A });
    const closed = await POST(
      await buildRequest("/api/jobs", {
        userId: USER_A,
        body: {
          mode: "stock",
          jobKind: "stream",
          pdfStoragePath: upload.body.storagePath,
          catalogVoiceId: "randolph",
          stockDelivery: "expressive",
        },
      })
    );
    expect(closed.status).toBe(400);
    const closedBody = await closed.json();
    expect(closedBody.code).toBe("EXPRESSIVE_UNAVAILABLE");

    const clara = await POST(
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
    expect(clara.status).toBe(400);
    const claraBody = await clara.json();
    expect(claraBody.code).toBe("EXPRESSIVE_NOT_OFFERED");
  });

  it("does not reuse a ready Standard book as the Expressive duplicate", async () => {
    process.env.FISH_TWIN_MICHELLE = "1";
    process.env.FISH_TWIN_MICHELLE_REF = SAMPLE_REF;
    const upload = await uploadBookViaApi(BOOK, { userId: USER_A });
    const base = {
      mode: "stock",
      jobKind: "takehome",
      pdfStoragePath: upload.body.storagePath,
      bookTitle: "Quay",
      catalogVoiceId: "michelle",
    };
    const standard = await POST(
      await buildRequest("/api/jobs", { userId: USER_A, body: base })
    );
    expect(standard.status).toBe(200);
    const standardBody = await standard.json();
    await execute(`UPDATE jobs SET status = 'ready' WHERE id = ?`, [
      standardBody.jobId,
    ]);

    const expressive = await POST(
      await buildRequest("/api/jobs", {
        userId: USER_A,
        body: { ...base, stockDelivery: "expressive" },
      })
    );
    expect(expressive.status).toBe(200);
    const expressiveBody = await expressive.json();
    expect(expressiveBody.duplicate).toBeUndefined();
    expect(expressiveBody.jobId).not.toBe(standardBody.jobId);
    const row = await jobRow(expressiveBody.jobId as string);
    expect(row?.tts_provider).toBe("fish");
    expect(row?.voice_name).toBe("Michelle (Expressive)");
  });
});
