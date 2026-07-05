/**
 * Universal text extraction — converts any supported document into plain text
 * for the TTS pipeline.
 *
 * Supported formats:
 *   - PDF  (via unpdf)
 *   - EPUB (via epub2)
 *   - DOCX (via mammoth)
 *   - TXT  (raw UTF-8 read)
 *   - RTF  (stripped via regex — no external dep needed)
 *   - MOBI / AZW3 / AZW4 — not natively parseable in Node;
 *     requires Calibre's ebook-convert on the server. Falls back with a clear error.
 */

export type DocumentFormat = "pdf" | "epub" | "docx" | "txt" | "rtf" | "mobi" | "unknown";

const EXT_MAP: Record<string, DocumentFormat> = {
  pdf: "pdf",
  epub: "epub",
  docx: "docx",
  doc: "docx",
  txt: "txt",
  text: "txt",
  rtf: "rtf",
  mobi: "mobi",
  azw: "mobi",
  azw3: "mobi",
  azw4: "mobi",
};

const MIME_MAP: Record<string, DocumentFormat> = {
  "application/pdf": "pdf",
  "application/epub+zip": "epub",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/msword": "docx",
  "text/plain": "txt",
  "application/rtf": "rtf",
  "text/rtf": "rtf",
  "application/x-mobipocket-ebook": "mobi",
};

export function detectFormat(fileName: string, mimeType?: string): DocumentFormat {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  if (EXT_MAP[ext]) return EXT_MAP[ext];
  if (mimeType && MIME_MAP[mimeType]) return MIME_MAP[mimeType];
  return "unknown";
}

export const SUPPORTED_DOCUMENT_EXTENSIONS = Object.keys(EXT_MAP);
export const SUPPORTED_DOCUMENT_ACCEPT = SUPPORTED_DOCUMENT_EXTENSIONS.map(e => `.${e}`).join(",");

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
export async function extractTextFromDocument(
  buffer: Buffer,
  fileName: string,
  mimeType?: string,
): Promise<string> {
  const format = detectFormat(fileName, mimeType);

  switch (format) {
    case "pdf":
      return extractPDF(buffer);
    case "epub":
      return extractEPUB(buffer);
    case "docx":
      return extractDOCX(buffer);
    case "txt":
      return extractTXT(buffer);
    case "rtf":
      return extractRTF(buffer);
    case "mobi":
      return extractMOBI(buffer, fileName);
    default:
      throw new Error(
        `Unsupported document format: .${fileName.split(".").pop()}. ` +
        `Supported formats: PDF, EPUB, DOCX, TXT, RTF, MOBI`
      );
  }
}

// ── PDF ────────────────────────────────────────────────────────────────

async function extractPDF(buffer: Buffer): Promise<string> {
  const { extractText } = await import("unpdf");
  const { text } = await extractText(new Uint8Array(buffer), { mergePages: true });

  if (!text?.trim()) {
    throw new Error("Could not extract text from PDF. Is it a scanned document?");
  }
  return normalizeExtractedText(text as string);
}

// ── EPUB ───────────────────────────────────────────────────────────────

type EpubChapterRef = { id?: string; href?: string; title?: string };

/** epub2's ESM default export is a namespace object in Next.js — resolve the real class. */
async function resolveEPubClass() {
  const mod = await import("epub2");
  const EPub =
    mod.EPub ??
    (mod.default as { EPub?: typeof mod.EPub; createAsync?: unknown })?.EPub ??
    mod.default;

  if (!EPub || typeof EPub.createAsync !== "function") {
    throw new Error("EPUB parser is unavailable on this server.");
  }
  return EPub;
}

function collectEpubSpine(epub: {
  flow?: EpubChapterRef[];
  spine?: { contents?: EpubChapterRef[] };
}): EpubChapterRef[] {
  const seen = new Set<string>();
  const items: EpubChapterRef[] = [];
  for (const item of [...(epub.flow ?? []), ...(epub.spine?.contents ?? [])]) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return items;
}

async function extractEPUB(buffer: Buffer): Promise<string> {
  const EPub = await resolveEPubClass();
  const fs = await import("fs");
  const path = await import("path");
  const os = await import("os");

  // epub2 requires a file path, not a buffer — write to temp file
  const tempDir = os.tmpdir();
  const tempPath = path.join(tempDir, `echomancer_epub_${Date.now()}.epub`);

  try {
    fs.writeFileSync(tempPath, buffer);

    const epub = await EPub.createAsync(tempPath);
    const spine = collectEpubSpine(epub);
    const chapters: string[] = [];

    for (const item of spine) {
      if (!item.id) continue;
      try {
        const html = await epub.getChapterAsync(item.id);
        const plain = stripHtml(html);
        if (plain.trim()) {
          chapters.push(plain.trim());
        }
      } catch {
        // Skip non-text spine entries (images, css, etc.)
      }
    }

    if (chapters.length === 0) {
      throw new Error(
        "Could not extract text from EPUB. The file may be empty, DRM-protected, or use an unsupported encoding (UTF-8 required)."
      );
    }

    return normalizeExtractedText(chapters.join("\n\n"));
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* ignore */
    }
  }
}

// ── DOCX ───────────────────────────────────────────────────────────────

async function extractDOCX(buffer: Buffer): Promise<string> {
  const mammoth = await import("mammoth");

  const result = await mammoth.extractRawText({ buffer });

  if (!result.value?.trim()) {
    throw new Error("Could not extract text from DOCX. The file may be empty or corrupted.");
  }

  return normalizeExtractedText(result.value);
}

// ── TXT ────────────────────────────────────────────────────────────────

function extractTXT(buffer: Buffer): Promise<string> {
  const text = buffer.toString("utf-8");
  if (!text.trim()) {
    throw new Error("The text file is empty.");
  }
  return Promise.resolve(normalizeExtractedText(text));
}

// ── RTF ────────────────────────────────────────────────────────────────

function extractRTF(buffer: Buffer): Promise<string> {
  const raw = buffer.toString("utf-8");

  // Strip RTF control words and braces — crude but effective for plain text extraction
  let text = raw
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

async function extractMOBI(buffer: Buffer, fileName: string): Promise<string> {
  // MOBI/AZW formats require Calibre's ebook-convert tool.
  // Attempt conversion via ffmpeg-like approach: try calibre, fall back to error.
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const fs = await import("fs");
  const path = await import("path");
  const os = await import("os");

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

    fs.writeFileSync(inputPath, buffer);

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
