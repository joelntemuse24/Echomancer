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

import { sniffDocumentFormat } from "@/lib/document-formats";

export {
  detectFormat,
  SUPPORTED_DOCUMENT_ACCEPT,
  SUPPORTED_DOCUMENT_EXTENSIONS,
  type DocumentFormat,
} from "@/lib/document-formats";

/** Minimum extracted characters to accept an upload (rejects empty/scanned docs). */
export const MIN_EXTRACTED_CHARS = 50;

/**
 * Normalize extracted document text for TTS: preserve paragraph breaks,
 * fix line-break hyphenation, and strip common page-number/header noise.
 */
export function normalizeExtractedText(raw: string): string {
  let text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

  // word-\nword → wordword (PDF line-break hyphenation)
  text = text.replace(/(\p{L})-\n(\p{L})/gu, "$1$2");

  // Common running headers / page numbers on their own lines
  text = text.replace(/^\s*page\s+\d{1,4}(\s+of\s+\d{1,4})?\s*$/gim, "");
  text = text.replace(/^\s*[-–—]\s*\d{1,4}\s*[-–—]\s*$/gm, "");

  text = text.replace(/\n{3,}/g, "\n\n");

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((block) =>
      block
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" ")
    )
    .map((p) => p.replace(/[^\S\n]+/g, " ").trim())
    .filter(Boolean);

  return paragraphs.join("\n\n");
}

/**
 * Extract plain text from any supported document buffer.
 */
function asUint8Array(input: Uint8Array | Buffer): Uint8Array {
  // unpdf/pdf.js throws if it receives a Node Buffer (a Uint8Array subclass).
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

export async function extractTextFromDocument(
  input: Uint8Array | Buffer,
  fileName: string,
  mimeType?: string,
): Promise<string> {
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

async function extractPDF(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  let text: unknown;
  try {
    const pdf = await getDocumentProxy(bytes);
    ({ text } = await extractText(pdf, { mergePages: true }));
  } catch {
    ({ text } = await extractText(bytes, { mergePages: true }));
  }
  const joined = joinExtractedPdfText(text);

  if (!joined.trim()) {
    throw new Error("Could not extract text from PDF. Is it a scanned document?");
  }
  return normalizeExtractedText(joined);
}

function joinExtractedPdfText(text: unknown): string {
  if (typeof text === "string") return text;
  if (Array.isArray(text)) {
    return text
      .filter((page): page is string => typeof page === "string")
      .join("\n\n");
  }
  return "";
}

// ── EPUB ───────────────────────────────────────────────────────────────

function attr(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}="([^"]+)"`, "i"));
  return match?.[1] ?? null;
}

async function extractEPUB(bytes: Uint8Array): Promise<string> {
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

  const chapters: string[] = [];
  for (const id of spineIds) {
    const href = hrefById.get(id);
    if (!href) continue;
    const entry = zip.file(opfDir + href) || zip.file(decodeURIComponent(opfDir + href));
    if (!entry) continue;
    try {
      const html = await entry.async("string");
      const plain = stripHtml(html);
      if (plain.trim()) chapters.push(plain.trim());
    } catch {
      // Skip non-text spine entries.
    }
  }

  if (chapters.length === 0) {
    throw new Error(
      "Could not extract text from EPUB. The file may be empty, DRM-protected, or use an unsupported encoding (UTF-8 required)."
    );
  }

  return normalizeExtractedText(chapters.join("\n\n"));
}

// ── DOCX ───────────────────────────────────────────────────────────────

async function extractDOCX(bytes: Uint8Array): Promise<string> {
  const mammoth = await import("mammoth");
  const buffer =
    typeof Buffer !== "undefined"
      ? Buffer.from(bytes)
      : undefined;
  const result = await mammoth.extractRawText(
    buffer
      ? { buffer }
      : {
          arrayBuffer: bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength
          ) as ArrayBuffer,
        }
  );

  if (!result.value?.trim()) {
    throw new Error("Could not extract text from DOCX. The file may be empty or corrupted.");
  }

  return normalizeExtractedText(result.value);
}

// ── TXT ────────────────────────────────────────────────────────────────

function extractTXT(bytes: Uint8Array): Promise<string> {
  const text = new TextDecoder("utf-8").decode(bytes);
  if (!text.trim()) {
    throw new Error("The text file is empty.");
  }
  return Promise.resolve(normalizeExtractedText(text));
}

// ── RTF ────────────────────────────────────────────────────────────────

function extractRTF(bytes: Uint8Array): Promise<string> {
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

  return Promise.resolve(normalizeExtractedText(text));
}

// ── MOBI / AZW ─────────────────────────────────────────────────────────

async function extractMOBI(bytes: Uint8Array, fileName: string): Promise<string> {
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
    return normalizeExtractedText(text);
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
