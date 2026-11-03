/**
 * Paste-text intake stores the same chapter outline a document gets from
 * extraction, so generation and the player see one source of truth.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseChaptersDocument } from "@/lib/book-chapters";
import { setPageDepsForTests } from "@/lib/fetch-public-page";
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

  it("stores an EPUB link with the document outline, not a web-page unwrap", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file(
      "META-INF/container.xml",
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
    );
    zip.file(
      "OEBPS/content.opf",
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Quay</dc:title></metadata><manifest><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch1"/><itemref idref="ch2"/></spine></package>`
    );
    zip.file(
      "OEBPS/ch1.xhtml",
      `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter One</h1><p>The lamps were lit along the quay and the tide was turning before midnight.</p></body></html>`
    );
    zip.file(
      "OEBPS/ch2.xhtml",
      `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter Two</h1><p>Night settled over the harbour and the boats were still for a long while.</p></body></html>`
    );
    const bytes = Buffer.from(await zip.generateAsync({ type: "uint8array" }));
    setPageDepsForTests({
      lookup: async () => [{ address: "1.1.1.1", family: 4 }],
      request: async () => ({
        status: 200,
        headers: { "content-type": "application/epub+zip" },
        body: bytes,
      }),
    });
    try {
      const { POST } = await import("@/app/api/text/upload/route");
      const response = await POST(
        await buildRequest("/api/text/upload", {
          userId: USER_A,
          body: { url: "https://books.example/quay.epub" },
        })
      );
      const body = await response.json();
      expect(response.status).toBe(200);

      const { downloadFile } = await import("@/lib/storage");
      const stored = await downloadFile(`pdfs/${body.uploadId}/chapters.json`);
      const doc = parseChaptersDocument(Buffer.from(stored).toString("utf-8"));
      expect(doc!.source).toBe("epub-spine");
      expect(doc!.chapters.map((chapter) => chapter.title)).toEqual([
        "Chapter One",
        "Chapter Two",
      ]);
      const content = Buffer.from(
        await downloadFile(`pdfs/${body.uploadId}/content.txt`)
      ).toString("utf-8");
      expect(content).toContain("lamps were lit along the quay");
      expect(content).not.toContain("<h1>");
    } finally {
      setPageDepsForTests(null);
    }
  });
});
