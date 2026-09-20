import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_UPLOAD_MB,
  contentTypeForDocument,
  detectFormat,
  isAcceptableUploadDeclaration,
  isSupportedDocument,
  maxUploadMb,
  sniffDocumentFormat,
} from "@/lib/document-formats";

describe("maxUploadMb", () => {
  const previousMax = process.env.MAX_UPLOAD_MB;
  const previousPublic = process.env.NEXT_PUBLIC_MAX_UPLOAD_MB;

  afterEach(() => {
    if (previousMax === undefined) delete process.env.MAX_UPLOAD_MB;
    else process.env.MAX_UPLOAD_MB = previousMax;
    if (previousPublic === undefined) delete process.env.NEXT_PUBLIC_MAX_UPLOAD_MB;
    else process.env.NEXT_PUBLIC_MAX_UPLOAD_MB = previousPublic;
  });

  it("defaults to a book-real 512MB ceiling, not the old 25MB leftover", () => {
    delete process.env.MAX_UPLOAD_MB;
    delete process.env.NEXT_PUBLIC_MAX_UPLOAD_MB;
    expect(DEFAULT_MAX_UPLOAD_MB).toBe(512);
    expect(maxUploadMb()).toBe(512);
    expect(maxUploadMb()).not.toBe(25);
  });
});

describe("detectFormat", () => {
  it("treats charset-suffixed and alias PDF MIME types as PDF", () => {
    expect(detectFormat("book", "application/pdf; charset=binary")).toBe("pdf");
    expect(detectFormat("book", "application/x-pdf")).toBe("pdf");
    expect(detectFormat("notes", "text/plain; charset=utf-8")).toBe("txt");
  });

  it("still prefers a real extension over a missing MIME", () => {
    expect(detectFormat("Sample 2 chapters.pdf", "")).toBe("pdf");
    expect(detectFormat("chapter.PDF", "application/octet-stream")).toBe("pdf");
  });
});

describe("sniffDocumentFormat", () => {
  it("recognizes a PDF from magic bytes when the name and MIME are unhelpful", () => {
    const bytes = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n");
    expect(
      sniffDocumentFormat(bytes, "download", "application/octet-stream")
    ).toBe("pdf");
  });
});

describe("isAcceptableUploadDeclaration", () => {
  it("lets octet-stream through so extract can sniff a nameless PDF", () => {
    expect(
      isAcceptableUploadDeclaration("My book", "application/octet-stream")
    ).toBe(true);
    expect(
      isSupportedDocument({ name: "My book", type: "application/octet-stream" })
    ).toBe(true);
    expect(isSupportedDocument({ name: "photo.png", type: "image/png" })).toBe(
      false
    );
  });
});

describe("contentTypeForDocument", () => {
  it("normalizes PDF aliases to application/pdf for the signed PUT", () => {
    expect(contentTypeForDocument("book", "application/x-pdf")).toBe(
      "application/pdf"
    );
    expect(
      contentTypeForDocument("book.pdf", "application/pdf; charset=binary")
    ).toBe("application/pdf");
  });
});
