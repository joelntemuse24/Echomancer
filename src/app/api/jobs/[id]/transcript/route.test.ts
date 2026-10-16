import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireOwnedJob: vi.fn(), loadFrozenScript: vi.fn(), downloadFile: vi.fn(),
}));
vi.mock("@/lib/auth/guard", () => ({ requireOwnedJob: mocks.requireOwnedJob }));
vi.mock("@/lib/storage", () => ({ downloadFile: mocks.downloadFile }));
vi.mock("@/lib/tts/frozen-script", () => ({
  loadFrozenScript: mocks.loadFrozenScript,
  sectionStartsPath: (id: string) => `audiobooks/${id}/section-starts.json`,
}));
import { GET } from "./route";

const request = () => new NextRequest("http://localhost/api/jobs/book/transcript");
const context = { params: Promise.resolve({ id: "book" }) };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireOwnedJob.mockResolvedValue({ job: {
    segments_json: "[]", pdf_storage_path: "pdfs/book/content.txt",
  } });
});

describe("transcript route", () => {
  it("refreshes extracted text to frozen speech and measured final timing", async () => {
    mocks.loadFrozenScript.mockResolvedValueOnce(null).mockResolvedValue({ sections: [
      { index: 0, text: "Frozen first." }, { index: 1, text: "Frozen second." },
    ] });
    mocks.downloadFile.mockImplementation(async (path: string) => Buffer.from(
      path.endsWith("content.txt") ? "Original text." : JSON.stringify({ sectionStarts: [0, 7], totalSeconds: 107 })
    ));
    const first = await GET(request(), context);
    expect((await first.json()).blocks[0].text).toBe("Original text.");
    const final = await GET(request(), context);
    const document = await final.json();
    expect(document.blocks[0].text).toBe("Frozen first.");
    expect(document.sections.map((section: { startSeconds: number }) => section.startSeconds)).toEqual([0, 7]);
    expect(document.sections.map((section: { durationSeconds: number }) => section.durationSeconds)).toEqual([7, 100]);
    expect(final.headers.get("cache-control")).toBe("private, no-store");
  });

  it("returns an error for transient text storage failures instead of caching an empty transcript", async () => {
    mocks.loadFrozenScript.mockResolvedValue(null);
    mocks.downloadFile.mockRejectedValueOnce(new Error("storage unavailable"));
    expect((await GET(request(), context)).status).toBe(500);
    mocks.downloadFile.mockResolvedValueOnce(Buffer.from("Recovered text."));
    expect((await (await GET(request(), context)).json()).blocks[0].text).toBe("Recovered text.");
  });

  it("checks ownership before reading any stored transcript", async () => {
    mocks.requireOwnedJob.mockRejectedValue(new Error("not owned"));
    await GET(request(), context);
    expect(mocks.downloadFile).not.toHaveBeenCalled();
    expect(mocks.loadFrozenScript).not.toHaveBeenCalled();
  });
});
