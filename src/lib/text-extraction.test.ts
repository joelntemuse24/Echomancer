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

  it("extracts a tiny two-chapter PDF via getDocumentProxy even without a .pdf name", async () => {
    const body =
      "Chapter One. The lamps were lit along the quay and the tide was turning. " +
      "Chapter Two. Night settled over the harbour and the boats were still.";
    const pdf = buildMinimalPdf(body);
    const text = await extractTextFromDocument(
      pdf,
      "download",
      "application/octet-stream"
    );
    expect(text).toMatch(/lamps were lit along the quay/i);
    expect(text.length).toBeGreaterThan(50);
  });
});

/** Uncompressed Type1 PDF with enough prose for MIN_EXTRACTED_CHARS. */
function buildMinimalPdf(text: string): Buffer {
  const safe = text.replace(/\\/g, "\\\\").replace(/[()]/g, "\\$&");
  const stream = `BT /F1 12 Tf 72 720 Td (${safe}) Tj ET`;
  const streamBytes = Buffer.byteLength(stream, "latin1");
  const objects = [
    "1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj",
    "2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj",
    "3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj",
    `4 0 obj<< /Length ${streamBytes} >>stream\n${stream}\nendstream\nendobj`,
    "5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${obj}\n`;
  }
  const xrefStart = Buffer.byteLength(body, "latin1");
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  body += xref;
  body += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}