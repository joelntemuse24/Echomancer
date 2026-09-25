/**
 * Universal text extraction — converts any supported document into plain text
 * for the TTS pipeline. Format detection lives in `document-formats.ts` so the
 * browser can share it without pulling the Node-only parsers into its bundle.
 *
 * Supported formats:
 *   - PDF  (via unpdf)
 *   - EPUB (via JSZip — buffer-only, Worker-safe)
 *   - DOCX (via mammoth)
 *   - TXT  (raw UTF-8 read)
 *   - RTF  (stripped via regex — no external dep needed)
 *   - MOBI / AZW3 / AZW4 — not natively parseable in Node;
 *     requires Calibre's ebook-convert on the server. Falls back with a clear error.
 */

import type { ChapterHint } from "@/lib/book-chapters";
import { sniffDocumentFormat } from "@/lib/document-formats";
import { bodyTextByPage, extractPdfPages, markFurniture } from "@/lib/pdf-furniture";
import { unwrapPdfLines, unwrapPdfPages } from "@/lib/pdf-line-unwrap";

export interface ExtractedDocument {
  text: string;
  hint: ChapterHint;
}

export {
  detectFormat,
  SUPPORTED_DOCUMENT_ACCEPT,
  SUPPORTED_DOCUMENT_EXTENSIONS,
  type DocumentFormat,
} from "@/lib/document-formats";

/** Minimum extracted characters to accept an upload (rejects empty/scanned docs). */
export const MIN_EXTRACTED_CHARS = 50;

/**
 * unpdf/pdf.js reject Node `Buffer` (a Uint8Array subclass) and may read
 * `.buffer` without `byteOffset`. Always copy into a standalone Uint8Array
 * whose backing store starts at the PDF/DOCX bytes.
 */
export function asUint8Array(input: Uint8Array | Buffer): Uint8Array {
  const view =
    typeof Buffer !== "undefined" && Buffer.isBuffer(input)
      ? input
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy;
}

/**
 * Normalize extracted document text for TTS.
 *
 * Blank-line paragraphs stay paragraphs. A block that is only visual line
 * wraps (PDF `hasEOL`) is unwrapped: dehyphenate, keep headings, and do not
 * space-join the whole block into one paragraph.
 */
export function normalizeExtractedText(raw: string): string {
  let text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  text = text.replace(/\u000c/g, "\n\n");
  text = text.replace(/[\x00-\x08\x0b\x0e-\x1f]/g, "");

  text = text.replace(/^\s*page\s+\d{1,4}(\s+of\s+\d{1,4})?\s*$/gim, "");
  text = text.replace(/^\s*[-–—]\s*\d{1,4}\s*[-–—]\s*$/gm, "");

  text = text.replace(/\n{3,}/g, "\n\n");

  const paragraphs: string[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;
    const unwrapped = lines.length === 1 ? lines : unwrapPdfLines(lines);
    for (const para of unwrapped) {
      const cleaned = para.replace(/[^\S\n]+/g, " ").trim();
      if (cleaned) paragraphs.push(cleaned);
    }
  }

  return paragraphs.join("\n\n");
}

function headingLinesHint(): ChapterHint {
  return { source: "heading-lines", titles: [] };
}

/** Extract plain text from any supported document buffer. */
export async function extractTextFromDocument(
  input: Uint8Array | Buffer,
  fileName: string,
  mimeType?: string,
): Promise<string> {
  const extracted = await extractDocument(input, fileName, mimeType);
  return extracted.text;
}

/** Text plus a chapter hint. Outline failure must not throw from here. */
export async function extractDocument(
  input: Uint8Array | Buffer,
  fileName: string,
  mimeType?: string,
): Promise<ExtractedDocument> {
  const bytes = asUint8Array(input);
  const format = sniffDocumentFormat(bytes, fileName, mimeType);

  switch (format) {
    case "pdf":
      return extractPDF(bytes);
    case "epub":
      return extractEPUB(bytes);
    case "docx":
      return extractDOCX(bytes);
    case "txt":
      return extractTXT(bytes);
    case "rtf":
      return extractRTF(bytes);
    case "mobi":
      return extractMOBI(bytes, fileName);
    default:
      throw new Error(
        `Unsupported document format: .${fileName.split(".").pop()}. ` +
        `Supported formats: PDF, EPUB, DOCX, TXT, RTF, MOBI`
      );
  }
}

// ── PDF ────────────────────────────────────────────────────────────────

async function extractPDF(bytes: Uint8Array): Promise<ExtractedDocument> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  let unwrapped = "";
  try {
    const pdf = await getDocumentProxy(bytes);
    const laid = await extractPdfPages(pdf);
    unwrapped = unwrapPdfPages(bodyTextByPage(markFurniture(laid)));
  } catch {
    unwrapped = "";
  }
  if (!unwrapped.trim()) {
    let text: unknown;
    try {
      const pdf = await getDocumentProxy(bytes);
      ({ text } = await extractText(pdf, { mergePages: false }));
    } catch {
      ({ text } = await extractText(bytes, { mergePages: false }));
    }
    unwrapped = unwrapPdfPages(pdfPageStrings(text));
  }

  if (!unwrapped.trim()) {
    throw new Error("Could not extract text from PDF. Is it a scanned document?");
  }
  return {
    text: normalizeExtractedText(unwrapped),
    hint: headingLinesHint(),
  };
}

function pdfPageStrings(text: unknown): string[] {
  if (typeof text === "string") return [text];
  if (Array.isArray(text)) {
    return text.filter((page): page is string => typeof page === "string");
  }
  return [];
}

// ── EPUB ───────────────────────────────────────────────────────────────

function attr(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}="([^"]+)"`, "i"));
  return match?.[1] ?? null;
}

function htmlHeadings(html: string): { title: string; level: number }[] {
  const headings: { title: string; level: number }[] = [];
  const re = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const title = stripHtml(match[2] || "")
      .replace(/\s+/g, " ")
      .trim();
    const level = Number(match[1]);
    if (!title || title.length > 160) continue;
    headings.push({
      title,
      level: level === 2 || level === 3 ? level : 1,
    });
  }
  return headings;
}

const EPUB_DROP_TYPES = new Set([
  "copyright-page",
  "toc",
  "index",
  "colophon",
  "loi",
  "lot",
]);

function epubTypes(tag: string): string[] {
  const raw = attr(tag, "epub:type") || attr(tag, "type") || "";
  return raw.toLowerCase().split(/\s+/).filter(Boolean);
}

function dropsEpubType(types: string[]): boolean {
  if (types.includes("dedication") || types.includes("epigraph")) return false;
  return types.some((type) => EPUB_DROP_TYPES.has(type));
}

/** Landmark and guide hrefs whose type is front matter we do not read. */
export function epubDropHrefs(xml: string): Set<string> {
  const hrefs = new Set<string>();
  const tags = xml.match(/<(?:a|reference)\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (!dropsEpubType(epubTypes(tag))) continue;
    const href = attr(tag, "href");
    if (href) hrefs.add(decodeURIComponent(href.split("#")[0] || ""));
  }
  return hrefs;
}

/** Remove PG boilerplate and typed copyright/toc/index sections. Dedication and epigraph stay. */
export function stripEpubFurniture(html: string): string {
  let out = html.replace(
    /<(section|div|header|footer)\b[^>]*\bid=["']pg-(?:header|footer)["'][^>]*>[\s\S]*?<\/\1>/gi,
    ""
  );
  out = out.replace(
    /<(section|div|nav)\b([^>]*)>([\s\S]*?)<\/\1>/gi,
    (full, _tag, attrs) => (dropsEpubType(epubTypes(String(attrs))) ? "" : full)
  );
  return out;
}

function isBoilerplateSpineHref(href: string): boolean {
  const name = href.split("/").pop()?.toLowerCase() || href.toLowerCase();
  return /^(?:nav|toc|cover|titlepage)(?:[._-]|\.|$)/.test(name);
}

async function extractEPUB(bytes: Uint8Array): Promise<ExtractedDocument> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  const containerXml = await zip.file("META-INF/container.xml")?.async("string");
  if (!containerXml) {
    throw new Error(
      "Could not extract text from EPUB. The file may be empty, DRM-protected, or use an unsupported encoding (UTF-8 required)."
    );
  }
  const rootMatch = containerXml.match(/full-path="([^"]+)"/i);
  const opfPath = rootMatch?.[1];
  if (!opfPath) {
    throw new Error(
      "Could not extract text from EPUB. The file may be empty, DRM-protected, or use an unsupported encoding (UTF-8 required)."
    );
  }
  const opfDir = opfPath.includes("/")
    ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1)
    : "";
  const opf = await zip.file(opfPath)?.async("string");
  if (!opf) {
    throw new Error(
      "Could not extract text from EPUB. The file may be empty, DRM-protected, or use an unsupported encoding (UTF-8 required)."
    );
  }

  const hrefById = new Map<string, string>();
  for (const itemTag of opf.match(/<item\b[^>]*>/gi) ?? []) {
    const id = attr(itemTag, "id");
    const href = attr(itemTag, "href");
    if (id && href) hrefById.set(id, href);
  }
  const spineIds = [
    ...opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/gi),
  ]
    .map((m) => m[1])
    .filter((id): id is string => Boolean(id));

  const spineDocs: { href: string; html: string }[] = [];
  for (const id of spineIds) {
    const href = hrefById.get(id);
    if (!href) continue;
    const entry = zip.file(opfDir + href) || zip.file(decodeURIComponent(opfDir + href));
    if (!entry) continue;
    try {
      const html = await entry.async("string");
      if (html.trim()) spineDocs.push({ href, html });
    } catch {
      // Skip non-text spine entries.
    }
  }

  const dropHrefs = epubDropHrefs(opf);
  for (const doc of spineDocs) {
    for (const href of epubDropHrefs(doc.html)) dropHrefs.add(href);
  }
  const hrefDropped = (href: string) => {
    const base = decodeURIComponent(href.split("#")[0] || "").split("/").pop() || "";
    for (const drop of dropHrefs) {
      const name = drop.split("/").pop() || drop;
      if (base && (base === name || href.endsWith(drop) || drop.endsWith(base))) return true;
    }
    return false;
  };
  const withoutBoilerplate = spineDocs.filter((doc) => {
    if (isBoilerplateSpineHref(doc.href) || hrefDropped(doc.href)) return false;
    const body = doc.html.match(/<body\b[^>]*>/i)?.[0] || "";
    return !dropsEpubType(epubTypes(body));
  });
  const chosen =
    withoutBoilerplate.length > 0 ? withoutBoilerplate : spineDocs;

  const titles: { title: string; level: number }[] = [];
  const chapters: string[] = [];
  for (const doc of chosen) {
    const html = stripEpubFurniture(doc.html);
    titles.push(...htmlHeadings(html));
    const plain = stripHtml(html);
    if (plain.trim()) chapters.push(plain.trim());
  }

  if (chapters.length === 0) {
    throw new Error(
      "Could not extract text from EPUB. The file may be empty, DRM-protected, or use an unsupported encoding (UTF-8 required)."
    );
  }

  return {
    text: normalizeExtractedText(chapters.join("\n\n")),
    hint: { source: "epub-spine", titles },
  };
}

type BufferPolyfill = {
  from(input: Uint8Array): unknown;
  isBuffer(value: unknown): boolean;
};

/**
 * Mammoth options for one DOCX.
 *
 * Always send a standalone `arrayBuffer` (`bytes.buffer.slice`). The extract
 * Worker bundles mammoth's browser unzip, which opens that key only and
 * throws "Could not find file in options" for `buffer`, `path`, or a
 * polyfill object. A Worker `Buffer` often exists while `Buffer.isBuffer`
 * is false; that object must not be the file input. Include `buffer` only
 * when `Buffer.isBuffer(Buffer.from(bytes))` is true, so Node unzip (Vercel
 * and tests) can open the file too. Never send `path`.
 */
export function mammothInput(bytes: Uint8Array): {
  arrayBuffer: ArrayBuffer;
  buffer?: Buffer;
} {
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const polyfill = (globalThis as { Buffer?: Partial<BufferPolyfill> }).Buffer;
  if (
    !polyfill ||
    typeof polyfill.from !== "function" ||
    typeof polyfill.isBuffer !== "function"
  ) {
    return { arrayBuffer };
  }
  const buffer = polyfill.from(bytes);
  if (!polyfill.isBuffer(buffer)) return { arrayBuffer };
  return { arrayBuffer, buffer: buffer as Buffer };
}

// ── DOCX ───────────────────────────────────────────────────────────────

async function extractDOCX(bytes: Uint8Array): Promise<ExtractedDocument> {
  const mammoth = await import("mammoth");
  const input = mammothInput(bytes);
  try {
    const htmlResult = await mammoth.convertToHtml(input);
    const html = htmlResult.value || "";
    if (html.trim()) {
      const text = normalizeExtractedText(stripHtml(html));
      if (text.trim()) {
        return {
          text,
          hint: { source: "docx-heading", titles: htmlHeadings(html) },
        };
      }
    }
  } catch {
    // Fall through to raw text. The upload still succeeds without headings.
  }

  const result = await mammoth.extractRawText(input);
  if (!result.value?.trim()) {
    throw new Error("Could not extract text from DOCX. The file may be empty or corrupted.");
  }

  return {
    text: normalizeExtractedText(result.value),
    hint: headingLinesHint(),
  };
}

// ── TXT ────────────────────────────────────────────────────────────────

function extractTXT(bytes: Uint8Array): Promise<ExtractedDocument> {
  const text = new TextDecoder("utf-8").decode(bytes);
  if (!text.trim()) {
    throw new Error("The text file is empty.");
  }
  return Promise.resolve({
    text: normalizeExtractedText(text),
    hint: headingLinesHint(),
  });
}

// ── RTF ────────────────────────────────────────────────────────────────

function extractRTF(bytes: Uint8Array): Promise<ExtractedDocument> {
  const raw = new TextDecoder("utf-8").decode(bytes);

  // Strip RTF control words and braces — crude but effective for plain text extraction
  const text = raw
    .replace(/\\par[d]?/gi, "\n")
    .replace(/\\tab/gi, "\t")
    .replace(/\\line/gi, "\n")
    .replace(/\\[a-z]+\d*\s?/gi, "")   // control words
    .replace(/[{}]/g, "")               // braces
    .replace(/\\\\/g, "\\")             // escaped backslash
    .trim();

  if (!text.trim()) {
    throw new Error("Could not extract text from RTF. The file may be empty or corrupted.");
  }

  return Promise.resolve({
    text: normalizeExtractedText(text),
    hint: headingLinesHint(),
  });
}

// ── MOBI / AZW ─────────────────────────────────────────────────────────

async function extractMOBI(bytes: Uint8Array, fileName: string): Promise<ExtractedDocument> {
  // Calibre is Node-only. Cloudflare Workers (and Vercel without
  // ebook-convert) get a clear convert-first error — never child_process.
  let exec: typeof import("child_process").exec;
  let promisify: typeof import("util").promisify;
  let fs: typeof import("fs");
  let path: typeof import("path");
  let os: typeof import("os");
  try {
    ({ exec } = await import("child_process"));
    ({ promisify } = await import("util"));
    fs = await import("fs");
    path = await import("path");
    os = await import("os");
  } catch {
    throw new Error(
      `MOBI/AZW format requires Calibre (ebook-convert) to be installed on the server. ` +
      `Please convert "${fileName}" to EPUB or PDF first, or install Calibre.`
    );
  }

  const execAsync = promisify(exec);

  // Check if ebook-convert is available
  try {
    await execAsync("ebook-convert --version", { timeout: 5_000 });
  } catch {
    throw new Error(
      `MOBI/AZW format requires Calibre (ebook-convert) to be installed on the server. ` +
      `Please convert "${fileName}" to EPUB or PDF first, or install Calibre.`
    );
  }

  const tempDir = path.join(os.tmpdir(), `echomancer_mobi_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    const inputPath = path.join(tempDir, fileName.replace(/[^a-zA-Z0-9._-]/g, "_"));
    const outputPath = path.join(tempDir, "output.txt");

    fs.writeFileSync(inputPath, Buffer.from(bytes));

    await execAsync(`ebook-convert "${inputPath}" "${outputPath}"`, {
      timeout: 60_000,
    });

    const text = fs.readFileSync(outputPath, "utf-8");
    if (!text.trim()) {
      throw new Error("ebook-convert produced empty output. The MOBI file may be DRM-protected.");
    }
    return {
      text: normalizeExtractedText(text),
      hint: headingLinesHint(),
    };
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")             // strip remaining tags
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, "")              // numeric entities
    .replace(/\n{3,}/g, "\n\n")          // collapse excess newlines
    .trim();
}
