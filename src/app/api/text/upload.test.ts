/**
 * Paste-text intake stores the same chapter outline a document gets from
 * extraction, so generation and the player see one source of truth.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseChaptersDocument } from "@/lib/book-chapters";
import { USER_A, buildRequest, resetDatabase } from "@/test/harness";

vi.mock("@trigger.dev/sdk", () => ({
  configure: vi.fn(),
  tasks: {
    trigger: vi.fn().mockResolvedValue({ id: "run_test" }),
  },
}));

const CHAPTERED = [
  "Chapter One",
  "The lamps were lit along the quay and the tide was turning before midnight.",
  "Chapter Two",
  "Night settled over the harbour and the boats were still for a long while.",
].join("\n\n");

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetDatabase();
});

describe("POST /api/text/upload", () => {
  it("writes chapters.json next to content.txt for pasted text", async () => {
    const { POST } = await import("@/app/api/text/upload/route");
    const response = await POST(
      await buildRequest("/api/text/upload", {
        userId: USER_A,
        body: { text: CHAPTERED },
      })
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.uploadId).toBeTruthy();

    const { downloadFile } = await import("@/lib/storage");
    const stored = await downloadFile(`pdfs/${body.uploadId}/chapters.json`);
    const doc = parseChaptersDocument(Buffer.from(stored).toString("utf-8"));
    expect(doc).not.toBeNull();
    expect(doc!.source).toBe("heading-lines");
    expect(doc!.chapters.map((chapter) => chapter.title)).toEqual([
      "Chapter One",
      "Chapter Two",
    ]);
  });

  it("writes an empty outline for text without chapters, never a failure", async () => {
    const { POST } = await import("@/app/api/text/upload/route");
    const response = await POST(
      await buildRequest("/api/text/upload", {
        userId: USER_A,
        body: {
          text: "The lamps were lit along the quay and the tide was turning before midnight.",
        },
      })
    );
    const body = await response.json();
    expect(response.status).toBe(200);

    const { downloadFile } = await import("@/lib/storage");
    const stored = await downloadFile(`pdfs/${body.uploadId}/chapters.json`);
    const doc = parseChaptersDocument(Buffer.from(stored).toString("utf-8"));
    expect(doc).toEqual({ version: 1, source: "none", chapters: [] });
  });
});
