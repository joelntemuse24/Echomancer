import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_UPLOAD_MB,
  GOOGLE_DOCS_UPLOAD_MESSAGE,
  SUPPORTED_DOCUMENT_ACCEPT,
  contentTypeForDocument,
  contentTypeForSniffedDocument,
  detectFormat,
  isAcceptableUploadDeclaration,
  isGoogleAppsDocumentEntry,
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

  it("recognizes a Drive-stripped plain-text file from byte printability", () => {
    const text = new TextEncoder().encode(
      "Chapter One\n\nIt was a bright cold day in April, and the clocks were striking thirteen.\n"
    );
    expect(sniffDocumentFormat(text, "book", "application/octet-stream")).toBe(
      "txt"
    );
    expect(sniffDocumentFormat(text, "notes", "")).toBe("txt");
  });

  it("does not mistake binary junk for text", () => {
    const junk = new Uint8Array(4096);
    for (let i = 0; i < junk.length; i++) junk[i]! = (i * 31 + 17) % 256;
    expect(
      sniffDocumentFormat(junk, "file", "application/octet-stream")
    ).toBe("unknown");
  });
});

describe("Google Docs handling", () => {
  it("detects Drive-native MIME types and .gdoc shortcut names", () => {
    expect(
      isGoogleAppsDocumentEntry("Untitled", "application/vnd.google-apps.document")
    ).toBe(true);
    expect(isGoogleAppsDocumentEntry("my-sheet.gsheet", "")).toBe(true);
    expect(isGoogleAppsDocumentEntry("book.pdf", "application/pdf")).toBe(
      false
    );
    expect(isGoogleAppsDocumentEntry("book", "application/octet-stream")).toBe(
      false
    );
    expect(GOOGLE_DOCS_UPLOAD_MESSAGE).toMatch(/download/i);
  });
});

describe("SUPPORTED_DOCUMENT_ACCEPT", () => {
  it("lists extensions and MIME types so Drive items are not greyed out", () => {
    const parts = SUPPORTED_DOCUMENT_ACCEPT.split(",");
    expect(parts).toContain(".pdf");
    expect(parts).toContain(".epub");
    expect(parts).toContain("application/pdf");
    expect(parts).toContain("application/epub+zip");
    expect(parts).toContain("text/plain");
  });
});

describe("contentTypeForSniffedDocument", () => {
  it("maps a sniffed format to the signed PUT content type", () => {
    expect(contentTypeForSniffedDocument("pdf")).toBe("application/pdf");
    expect(contentTypeForSniffedDocument("txt")).toBe("text/plain");
    expect(contentTypeForSniffedDocument("unknown")).toBe(
      "application/octet-stream"
    );
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
