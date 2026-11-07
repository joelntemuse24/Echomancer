import { afterEach, describe, expect, it, vi } from "vitest";
import { startStockBook } from "./stock-job-create";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("startStockBook", () => {
  it("posts Sowell as the catalog voice and does not rewrite it", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ jobId: "job_sowell", status: "queued" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const started = await startStockBook({
      pdfStoragePath: "pdfs/upload/source.pdf",
      bookTitle: "Short note",
      catalogVoiceId: "sowell",
      voiceName: "Sowell · American",
      charCount: 1200,
    });

    expect(started.jobId).toBe("job_sowell");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      mode: "stock",
      jobKind: "takehome",
      catalogVoiceId: "sowell",
      voiceName: "Sowell · American",
      pdfStoragePath: "pdfs/upload/source.pdf",
    });
    expect(body.catalogVoiceId).not.toBe("standard");
  });
});
