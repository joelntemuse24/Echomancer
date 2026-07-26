import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  downloadFile: vi.fn(),
  execute: vi.fn(),
  queryOne: vi.fn(),
  getCatalogVoice: vi.fn(),
  isStockProvider: vi.fn(),
  resolveStockAdapter: vi.fn(),
  splitTextForTts: vi.fn(),
  ensureTtsJobColumns: vi.fn(),
  logUsage: vi.fn(),
}));

vi.mock("@/lib/storage", () => ({ downloadFile: mocks.downloadFile }));
vi.mock("@/lib/turso", () => ({
  execute: mocks.execute,
  queryOne: mocks.queryOne,
}));
vi.mock("@/lib/tts/catalog", () => ({
  getCatalogVoice: mocks.getCatalogVoice,
}));
vi.mock("@/lib/tts/providers", () => ({
  isStockProvider: mocks.isStockProvider,
  resolveStockAdapter: mocks.resolveStockAdapter,
}));
vi.mock("@/lib/tts/pricing", () => ({ streamMaxChars: () => 10_000 }));
vi.mock("@/lib/tts/split-text", () => ({
  splitTextForTts: mocks.splitTextForTts,
}));
vi.mock("@/lib/tts/schema-migrate", () => ({
  ensureTtsJobColumns: mocks.ensureTtsJobColumns,
}));
vi.mock("@/lib/turso/jobs", () => ({ logUsage: mocks.logUsage }));

import { createStreamAudioIterator } from "@/lib/tts/stream-session";

describe("createStreamAudioIterator", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.ensureTtsJobColumns.mockResolvedValue(undefined);
    mocks.isStockProvider.mockReturnValue(true);
    mocks.downloadFile.mockResolvedValue(Buffer.from("book text"));
    mocks.splitTextForTts.mockReturnValue(["book text"]);
    mocks.resolveStockAdapter.mockReturnValue({
      streamContentType: "audio/mpeg",
      synthesizeStream: vi.fn(),
    });
    mocks.execute.mockResolvedValue({ rowsAffected: 1 });
    mocks.queryOne.mockResolvedValue({
      id: "stream-1",
      pdf_storage_path: "pdfs/book.txt",
      tts_provider: "google",
      provider_voice_id: "en-US-Neural2-D",
      catalog_voice_id: null,
      tts_options: null,
      stream_cursor: 0,
      stream_chars_used: 0,
      stream_max_chars: 10_000,
      job_kind: "stream",
      status: "queued",
    });
  });

  it("claims only queued, ready, or stale processing sessions", async () => {
    await createStreamAudioIterator("stream-1");

    expect(mocks.execute).toHaveBeenCalledTimes(1);
    const [sql, values] = mocks.execute.mock.calls[0]!;
    expect(sql).toContain("processing_started_at IS NOT NULL");
    expect(sql).toContain("unixepoch() - processing_started_at > ?");
    expect(sql).not.toContain("OR status = 'processing'");
    expect(values).toEqual(["stream-1", 330]);
  });
});
