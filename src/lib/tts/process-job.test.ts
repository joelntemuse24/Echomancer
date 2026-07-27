import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  downloadFile: vi.fn(),
  uploadFile: vi.fn(),
  execute: vi.fn(),
  queryOne: vi.fn(),
  updateJob: vi.fn(),
  logUsage: vi.fn(),
  getCatalogVoice: vi.fn(),
  isStockProvider: vi.fn(),
  resolveStockAdapter: vi.fn(),
  splitTextForTts: vi.fn(),
  ensureTtsJobColumns: vi.fn(),
  synthesize: vi.fn(),
}));

vi.mock("@/lib/storage", () => ({
  downloadFile: mocks.downloadFile,
  uploadFile: mocks.uploadFile,
}));
vi.mock("@/lib/turso", () => ({
  execute: mocks.execute,
  queryOne: mocks.queryOne,
}));
vi.mock("@/lib/turso/jobs", () => ({
  updateJob: mocks.updateJob,
  logUsage: mocks.logUsage,
}));
vi.mock("@/lib/tts/catalog", () => ({
  getCatalogVoice: mocks.getCatalogVoice,
}));
vi.mock("@/lib/tts/providers", () => ({
  isStockProvider: mocks.isStockProvider,
  resolveStockAdapter: mocks.resolveStockAdapter,
}));
vi.mock("@/lib/tts/split-text", () => ({
  splitTextForTts: mocks.splitTextForTts,
}));
vi.mock("@/lib/tts/schema-migrate", () => ({
  ensureTtsJobColumns: mocks.ensureTtsJobColumns,
}));

import { processTakehomeTick } from "@/lib/tts/process-job";

describe("processTakehomeTick", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.TTS_SECTIONS_PER_TICK = "3";
    mocks.ensureTtsJobColumns.mockResolvedValue(undefined);
    mocks.isStockProvider.mockReturnValue(true);
    mocks.downloadFile.mockResolvedValue(Buffer.from("book"));
    mocks.splitTextForTts.mockReturnValue(["a", "b", "c", "d", "e", "f"]);
    mocks.resolveStockAdapter.mockReturnValue({ synthesize: mocks.synthesize });
    mocks.execute.mockResolvedValue({ rowsAffected: 1 });
  });

  it("persists progress when the entire tick window is already ready", async () => {
    mocks.queryOne.mockResolvedValue({
      id: "job-1",
      status: "queued",
      pdf_storage_path: "pdfs/book.txt",
      book_title: "Book",
      voice_name: "Voice",
      tts_provider: "google",
      provider_voice_id: "en-US-Neural2-D",
      catalog_voice_id: null,
      tts_options: null,
      segments_json: JSON.stringify([
        { index: 0, path: "sections/0.mp3", status: "ready" },
        { index: 1, path: "sections/1.mp3", status: "ready" },
        { index: 2, path: "sections/2.mp3", status: "ready" },
      ]),
      next_section_index: 0,
      total_sections: 6,
      char_count: 6,
      job_kind: "takehome",
      generation_mode: "stock",
    });

    const result = await processTakehomeTick("job-1");

    expect(result).toEqual({ done: false, nextIndex: 3, total: 6 });
    expect(mocks.synthesize).not.toHaveBeenCalled();
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    const [sql, values] = mocks.execute.mock.calls[1]!;
    expect(sql).toContain("next_section_index = ?");
    expect(sql).toContain("progress = ?");
    expect(values).toEqual([3, 50, 3, "job-1"]);
  });
});
