import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";

const { mammothCalls } = vi.hoisted(() => ({
  mammothCalls: [] as unknown[],
}));

vi.mock("mammoth", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("mammoth");
  const api = (actual.default ?? actual) as typeof import("mammoth");
  const record = (input: unknown) => {
    mammothCalls.push(input);
  };
  const wrapped = {
    ...api,
    convertToHtml: (
      input: Parameters<typeof api.convertToHtml>[0],
      options?: Parameters<typeof api.convertToHtml>[1]
    ) => {
      record(input);
      return api.convertToHtml(input, options);
    },
    extractRawText: (input: Parameters<typeof api.extractRawText>[0]) => {
      record(input);
      return api.extractRawText(input);
    },
  };
  return { ...wrapped, default: wrapped };
});

import { safeResolveChapters } from "./book-chapters";
import { toSpeakableText } from "./tts/speakable-text";
import {
  asUint8Array,
  detectFormat,
  extractDocument,
  extractTextFromDocument,
  mammothInput,
  normalizeExtractedText,
  stripEpubFurniture,
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

  it("drops typed EPUB front matter and keeps a dedication", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file(
      "META-INF/container.xml",
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
    );
    zip.file(
      "OEBPS/content.opf",
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Quay</dc:title></metadata><manifest><item id="copy" href="copy.xhtml" media-type="application/xhtml+xml"/><item id="ded" href="ded.xhtml" media-type="application/xhtml+xml"/><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="copy"/><itemref idref="ded"/><itemref idref="ch1"/></spine></package>`
    );
    zip.file(
      "OEBPS/copy.xhtml",
      `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body epub:type="copyright-page"><p>Copyright 1903 Example Press. All rights reserved.</p></body></html>`
    );
    zip.file(
      "OEBPS/ded.xhtml",
      `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body epub:type="dedication"><p>For the harbor master, who kept the lamp.</p><section id="pg-header"><p>Project Gutenberg header boilerplate.</p></section><section epub:type="epigraph"><p>The tide remembers.</p></section></body></html>`
    );
    zip.file(
      "OEBPS/ch1.xhtml",
      `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter One</h1><p>The lamps were lit along the quay.</p><section id="pg-footer"><p>End of the Project Gutenberg footer.</p></section></body></html>`
    );
    const text = await extractTextFromDocument(
      Buffer.from(await zip.generateAsync({ type: "uint8array" })),
      "quay.epub",
      "application/epub+zip"
    );
    expect(text).not.toMatch(/All rights reserved/i);
    expect(text).not.toMatch(/Gutenberg header/i);
    expect(text).not.toMatch(/Gutenberg footer/i);
    expect(text).toMatch(/harbor master/i);
    expect(text).toMatch(/tide remembers/i);
    expect(text).toMatch(/lamps were lit/i);
    expect(stripEpubFurniture(`<section epub:type="colophon"><p>Set in type.</p></section><p>Kept.</p>`)).not.toMatch(/Set in type/);
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

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type MammothZip = {
  read: (name: string, encoding?: string) => Promise<string | Uint8Array>;
};

describe("docx mammoth input", () => {
  it("fails on wrong options and reads text from arrayBuffer", async () => {
    const mammoth = await import("mammoth");
    const docx = await buildHeadingDocx();
    const bytes = asUint8Array(docx);
    const arrayBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    );

    await expect(mammoth.extractRawText({} as never)).rejects.toThrow(
      /Could not find file in options/
    );
    await expect(
      mammoth.convertToHtml({ ArrayBuffer: arrayBuffer } as never)
    ).rejects.toThrow(/Could not find file in options/);
    await expect(
      (
        mammoth as unknown as {
          convertToMarkdown: (input: unknown) => Promise<unknown>;
        }
      ).convertToMarkdown({ blob: bytes })
    ).rejects.toThrow(/Could not find file in options/);
    // Node unzip ignores arrayBuffer. The Worker browser build requires it.
    await expect(
      mammoth.extractRawText({ arrayBuffer } as never)
    ).rejects.toThrow(/Could not find file in options/);

    const browserUnzip = require("mammoth/browser/unzip.js") as {
      openZip: (options: Record<string, unknown>) => Promise<MammothZip>;
    };
    await expect(browserUnzip.openZip({})).rejects.toThrow(
      /Could not find file in options/
    );
    await expect(
      browserUnzip.openZip({ buffer: Buffer.from(bytes) })
    ).rejects.toThrow(/Could not find file in options/);
    await expect(browserUnzip.openZip({ path: "quay.docx" })).rejects.toThrow(
      /Could not find file in options/
    );

    const opened = await browserUnzip.openZip({ arrayBuffer });
    const xml = String(await opened.read("word/document.xml", "utf-8"));
    expect(xml).toMatch(/Foreword/);
    expect(xml).toMatch(/Chapter One/);

    const padded = Buffer.concat([
      Buffer.alloc(24, 0xab),
      docx,
      Buffer.alloc(8, 0xcd),
    ]);
    const view = padded.subarray(24, 24 + docx.length);
    const input = mammothInput(view);
    expect(input).not.toHaveProperty("path");
    expect(input.arrayBuffer).toBeInstanceOf(ArrayBuffer);
    expect(input.arrayBuffer.byteLength).toBe(docx.length);
    expect(Buffer.from(input.arrayBuffer).equals(docx)).toBe(true);
    expect(Buffer.isBuffer(input.buffer)).toBe(true);

    const fromBrowser = await browserUnzip.openZip(input);
    expect(String(await fromBrowser.read("word/document.xml", "utf-8"))).toMatch(
      /lamps were lit along the quay/
    );
    const raw = await mammoth.extractRawText(input);
    expect(raw.value).toMatch(/Foreword/);
    expect(raw.value).toMatch(/lamps were lit along the quay/);
    const html = await mammoth.convertToHtml(input);
    expect(html.value).toMatch(/Chapter One/);
  });

  it("passes arrayBuffer and buffer into extractDocument", async () => {
    const docx = await buildHeadingDocx();
    const padded = Buffer.concat([
      Buffer.alloc(32, 0x11),
      docx,
      Buffer.alloc(16, 0x22),
    ]);
    const view = padded.subarray(32, 32 + docx.length);
    mammothCalls.length = 0;
    const extracted = await extractDocument(view, "quay.docx", DOCX_MIME);
    expect(extracted.hint.source).toBe("docx-heading");
    expect(extracted.text).toMatch(/lamps were lit along the quay/i);
    const input = mammothCalls[0] as {
      arrayBuffer?: ArrayBuffer;
      buffer?: Buffer;
      path?: string;
    };
    expect(input?.arrayBuffer).toBeInstanceOf(ArrayBuffer);
    expect(input.arrayBuffer?.byteLength).toBe(docx.length);
    expect(Buffer.from(input.arrayBuffer!).equals(docx)).toBe(true);
    expect(Buffer.isBuffer(input.buffer)).toBe(true);
    expect(input.path).toBeUndefined();

    const browserUnzip = require("mammoth/browser/unzip.js") as {
      openZip: (options: unknown) => Promise<MammothZip>;
    };
    const zip = await browserUnzip.openZip(input);
    expect(String(await zip.read("word/document.xml", "utf-8"))).toMatch(
      /Chapter One/
    );
  });

  it("passes arrayBuffer when a Buffer polyfill fails isBuffer", async () => {
    const docx = await buildHeadingDocx();
    const padded = Buffer.concat([
      Buffer.alloc(24, 0xab),
      docx,
      Buffer.alloc(8, 0xcd),
    ]);
    const view = padded.subarray(24, 24 + docx.length);
    const fakeBuffer = { fake: true, byteLength: view.byteLength };
    const fakeFrom = vi.fn(() => fakeBuffer);
    const fakeIsBuffer = vi.fn(() => false);
    let input: ReturnType<typeof mammothInput> | undefined;
    vi.stubGlobal("Buffer", { from: fakeFrom, isBuffer: fakeIsBuffer });
    try {
      expect(Buffer.isBuffer(Buffer.from(view))).toBe(false);
      input = mammothInput(view);
      expect(fakeFrom).toHaveBeenCalled();
      expect(fakeIsBuffer).toHaveBeenCalledWith(fakeBuffer);
      expect(input.arrayBuffer).toBeInstanceOf(ArrayBuffer);
      expect(input.arrayBuffer.byteLength).toBe(docx.length);
      expect(Array.from(new Uint8Array(input.arrayBuffer))).toEqual(
        Array.from(docx)
      );
      expect(input).not.toHaveProperty("buffer");
      expect(input).not.toHaveProperty("path");
    } finally {
      vi.unstubAllGlobals();
    }

    const browserUnzip = require("mammoth/browser/unzip.js") as {
      openZip: (options: Record<string, unknown>) => Promise<MammothZip>;
    };
    await expect(browserUnzip.openZip({ buffer: fakeBuffer })).rejects.toThrow(
      /Could not find file in options/
    );
    const zip = await browserUnzip.openZip({
      arrayBuffer: input!.arrayBuffer,
    });
    const xml = String(await zip.read("word/document.xml", "utf-8"));
    expect(xml).toMatch(/Foreword/);
    expect(xml).toMatch(/lamps were lit along the quay/);
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