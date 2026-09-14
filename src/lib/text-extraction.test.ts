import { describe, expect, it } from "vitest";
import { detectFormat, extractTextFromDocument, normalizeExtractedText } from "./text-extraction";

describe("detectFormat", () => {
  it("detects epub by extension", () => {
    expect(detectFormat("book.epub")).toBe("epub");
  });

  it("detects epub by mime when extension is missing", () => {
    expect(detectFormat("download", "application/epub+zip")).toBe("epub");
  });
});

describe("normalizeExtractedText", () => {
  it("preserves paragraph breaks", () => {
    const input = "First paragraph line one.\nStill first paragraph.\n\nSecond paragraph.";
    expect(normalizeExtractedText(input)).toBe(
      "First paragraph line one. Still first paragraph.\n\nSecond paragraph."
    );
  });

  it("fixes hyphenation across line breaks", () => {
    const input = "The com-\nputer was fast.";
    expect(normalizeExtractedText(input)).toBe("The computer was fast.");
  });

  it("strips standalone page numbers", () => {
    const input = "Chapter start.\n\nPage 12 of 200\n\nNext paragraph.";
    expect(normalizeExtractedText(input)).toBe(
      "Chapter start.\n\nNext paragraph."
    );
  });

  it("strips centered page markers", () => {
    const input = "End of section.\n\n— 42 —\n\nNew section.";
    expect(normalizeExtractedText(input)).toBe(
      "End of section.\n\nNew section."
    );
  });

  it("collapses excess blank lines", () => {
    const input = "One.\n\n\n\nTwo.";
    expect(normalizeExtractedText(input)).toBe("One.\n\nTwo.");
  });
});

describe("extractTextFromDocument", () => {
  it("reads a buffer EPUB without writing a temp file", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file(
      "META-INF/container.xml",
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
    );
    zip.file(
      "OEBPS/content.opf",
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Quay</dc:title></metadata><manifest><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch1"/></spine></package>`
    );
    zip.file(
      "OEBPS/ch1.xhtml",
      `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>The lamps were lit along the quay and the tide was turning.</p></body></html>`
    );
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const text = await extractTextFromDocument(
      Buffer.from(bytes),
      "quay.epub",
      "application/epub+zip"
    );
    expect(text).toMatch(/lamps were lit along the quay/i);
  });
});