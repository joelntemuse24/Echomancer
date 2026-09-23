import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { safeResolveChapters } from "./book-chapters";
import { toSpeakableText } from "./tts/speakable-text";
import {
  asUint8Array,
  detectFormat,
  extractDocument,
  extractTextFromDocument,
  normalizeExtractedText,
} from "./text-extraction";

const require = createRequire(import.meta.url);

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

describe("unpdf pin", () => {
  it("resolves unpdf 1.8.1 or newer so merged text cannot eat newlines", () => {
    const unpdfDir = dirname(dirname(require.resolve("unpdf")));
    const version = (
      JSON.parse(readFileSync(`${unpdfDir}/package.json`, "utf8")) as {
        version: string;
      }
    ).version;
    const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
    const ok =
      major > 1 ||
      (major === 1 && minor > 8) ||
      (major === 1 && minor === 8 && patch >= 1);
    expect(ok, `unpdf@${version}`).toBe(true);
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

  it("copies a sliced Node Buffer so unpdf never sees Buffer or a pooled offset", async () => {
    const body =
      "Chapter One. The lamps were lit along the quay and the tide was turning. " +
      "Chapter Two. Night settled over the harbour and the boats were still.";
    const pdf = buildMinimalPdf(body);
    const padded = Buffer.concat([
      Buffer.alloc(48, 0xff),
      pdf,
      Buffer.alloc(16, 0x00),
    ]);
    const sliced = padded.subarray(48, 48 + pdf.length);
    expect(Buffer.isBuffer(sliced)).toBe(true);
    expect(sliced.byteOffset).toBeGreaterThan(0);
    expect(sliced.equals(pdf)).toBe(true);

    const copied = asUint8Array(sliced);
    expect(copied).not.toBeInstanceOf(Buffer);
    expect(copied.byteOffset).toBe(0);
    expect(copied.buffer.byteLength).toBe(copied.byteLength);
    expect(copied[0]).toBe(0x25); // %
    expect(copied[1]).toBe(0x50); // P

    const text = await extractTextFromDocument(
      sliced,
      "download",
      "application/octet-stream"
    );
    expect(text).toMatch(/lamps were lit along the quay/i);
  });

  it("keeps PDF headings and joins a sentence that crosses a page", async () => {
    const pdf = buildLinedPdf([
      ["Chapter One", "The lamps were lit along the quay and the tide was"],
      [
        "turning slowly.",
        "Chapter Two",
        "Night settled over the harbour and the boats were still.",
      ],
    ]);
    const text = await extractTextFromDocument(pdf, "quay.pdf", "application/pdf");
    expect(text).toMatch(/^Chapter One\n\n/);
    expect(text).toContain(
      "The lamps were lit along the quay and the tide was turning slowly."
    );
    expect(text).toMatch(/Chapter Two\n\nNight settled/);
    expect(text).not.toMatch(/Chapter One The lamps/);
    expect(text).not.toMatch(/was\n\nturning/);
    expect(text).not.toMatch(/slowly\. Chapter Two/);
  });

  it("uses EPUB spine headings as the chapter outline", async () => {
    const extracted = await extractDocument(
      await buildChapterEpub(),
      "quay.epub",
      "application/epub+zip"
    );
    expect(extracted.hint.source).toBe("epub-spine");
    expect(extracted.hint.titles.map((title) => title.title)).toEqual([
      "Foreword",
      "Chapter One",
    ]);
    expect(extracted.text).not.toMatch(/contents filler/i);
    const spoken = toSpeakableText(extracted.text, { normalizeTitles: false });
    const chapters = safeResolveChapters(spoken, extracted.hint);
    expect(chapters.source).toBe("epub-spine");
    expect(chapters.chapters.map((chapter) => chapter.title)).toEqual([
      "Foreword",
      "Chapter One",
    ]);
    expect(spoken.slice(chapters.chapters[0]!.charStart)).toMatch(/^Foreword/);
  });

  it("uses DOCX heading styles as the chapter outline", async () => {
    const extracted = await extractDocument(
      await buildHeadingDocx(),
      "quay.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    expect(extracted.hint.source).toBe("docx-heading");
    expect(extracted.hint.titles.map((title) => title.title)).toEqual([
      "Foreword",
      "Chapter One",
    ]);
    const spoken = toSpeakableText(extracted.text, { normalizeTitles: false });
    const chapters = safeResolveChapters(spoken, extracted.hint);
    expect(chapters.source).toBe("docx-heading");
    expect(chapters.chapters.map((chapter) => chapter.title)).toEqual([
      "Foreword",
      "Chapter One",
    ]);
    expect(
      spoken.slice(
        chapters.chapters[1]!.charStart,
        chapters.chapters[1]!.charEnd
      )
    ).toMatch(/^Chapter One/);
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

/** One content stream per page, each visual line on its own `Td`. */
function buildLinedPdf(pages: string[][]): Buffer {
  const pagesId = 2;
  let next = 3;
  const pageRefs: number[] = [];
  const later: { id: number; body: string }[] = [];
  for (const lines of pages) {
    const pageId = next++;
    const contentId = next++;
    pageRefs.push(pageId);
    const cmds = ["BT /F1 12 Tf 72 720 Td"];
    lines.forEach((line, i) => {
      const safe = line.replace(/\\/g, "\\\\").replace(/[()]/g, "\\$&");
      cmds.push(i === 0 ? `(${safe}) Tj` : `0 -18 Td (${safe}) Tj`);
    });
    cmds.push("ET");
    const stream = cmds.join("\n");
    later.push({
      id: contentId,
      body: `${contentId} 0 obj<< /Length ${Buffer.byteLength(stream, "latin1")} >>stream\n${stream}\nendstream\nendobj`,
    });
    later.push({
      id: pageId,
      body: `${pageId} 0 obj<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 FONT 0 R >> >> >>endobj`,
    });
  }
  const fontId = next++;
  const ordered = new Array<string>(fontId);
  ordered[0] = "1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj";
  ordered[1] =
    `2 0 obj<< /Type /Pages /Kids [${pageRefs.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>endobj`;
  for (const item of later) {
    ordered[item.id - 1] = item.body.replaceAll("FONT", String(fontId));
  }
  ordered[fontId - 1] =
    `${fontId} 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj`;
  return assemblePdf(ordered);
}

function assemblePdf(objects: string[]): Buffer {
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

async function buildChapterEpub(): Promise<Uint8Array> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
  );
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Quay</dc:title></metadata><manifest><item id="nav" href="toc.xhtml" media-type="application/xhtml+xml"/><item id="fore" href="fore.xhtml" media-type="application/xhtml+xml"/><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="nav"/><itemref idref="fore"/><itemref idref="ch1"/></spine></package>`
  );
  zip.file(
    "OEBPS/toc.xhtml",
    `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Contents</h1><p>contents filler that must not be narrated as a chapter.</p></body></html>`
  );
  zip.file(
    "OEBPS/fore.xhtml",
    `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Foreword</h1><p>The lamps were lit along the quay and the tide was turning before midnight.</p></body></html>`
  );
  zip.file(
    "OEBPS/ch1.xhtml",
    `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter One</h1><p>Night settled over the harbour and the boats were still for a long while.</p></body></html>`
  );
  return zip.generateAsync({ type: "uint8array" });
}

async function buildHeadingDocx(): Promise<Buffer> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
  );
  zip.file(
    "word/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="Heading 1"/>
  </w:style>
</w:styles>`
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Foreword</w:t></w:r></w:p>
    <w:p><w:r><w:t>The lamps were lit along the quay and the tide was turning before midnight.</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Chapter One</w:t></w:r></w:p>
    <w:p><w:r><w:t>Night settled over the harbour and the boats were still for a long while.</w:t></w:r></w:p>
  </w:body>
</w:document>`
  );
  return zip.generateAsync({ type: "nodebuffer" });
}