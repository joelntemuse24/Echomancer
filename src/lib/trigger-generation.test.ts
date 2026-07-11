import { afterEach, describe, expect, it, vi } from "vitest";
import { triggerAudiobookGeneration } from "./trigger-generation";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("triggerAudiobookGeneration", () => {
  it("sends full-book jobs to the persisted Delay route with narration settings", async () => {
    vi.stubEnv(
      "MODAL_MOSS_DELAY_TTS_URL",
      "https://delay.example/generate_batch"
    );
    vi.stubEnv("MODAL_MOSS_SGLANG_TTS_URL", "https://sglang.example/generate_batch");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://echomancer.example");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "accepted" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await triggerAudiobookGeneration({
      jobId: "job-1",
      pdfStoragePath: "pdfs/book/content.txt",
      voiceStoragePath: "voices/reference.wav",
      startTime: 2,
      endTime: 28,
      bookTitle: "Book",
      voiceName: "Narrator",
      charCount: 50_000,
      paragraphCount: 80,
      mossAbVariant: "delay",
      mossLanguage: "English",
      voiceClips: [
        { label: "neutral", startTime: 2, endTime: 17 },
        { label: "dialogue", startTime: 40, endTime: 55 },
      ],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    const payload = JSON.parse(String(init.body));
    expect(url).toBe("https://delay.example/generate_audiobook");
    expect(payload).toMatchObject({
      job_id: "job-1",
      tts_variant: "delay",
      moss_language: "English",
      paragraph_pause_sec: 0.65,
      sentence_pause_sec: 0.22,
      audio_temperature: 1.82,
      audio_top_p: 0.8,
      audio_top_k: 25,
      reference_segments: [
        { label: "neutral", start_time: 2, end_time: 17 },
        { label: "dialogue", start_time: 40, end_time: 55 },
      ],
    });
  });

  it("keeps short jobs on SGLang", async () => {
    vi.stubEnv("MODAL_MOSS_SGLANG_TTS_URL", "https://sglang.example/generate_batch");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await triggerAudiobookGeneration({
      jobId: "job-2",
      pdfStoragePath: "pdfs/short/content.txt",
      voiceStoragePath: "voices/reference.wav",
      startTime: 0,
      endTime: 20,
      bookTitle: "Short",
      voiceName: "Narrator",
      charCount: 1000,
      paragraphCount: 1,
      mossAbVariant: "sglang",
    });

    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://sglang.example/generate_audiobook"
    );
  });
});
