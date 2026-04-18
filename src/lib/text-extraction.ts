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

export function detectFormat(fileName: string): DocumentFormat {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  return EXT_MAP[ext] ?? "unknown";
}

export const SUPPORTED_DOCUMENT_EXTENSIONS = Object.keys(EXT_MAP);
export const SUPPORTED_DOCUMENT_ACCEPT = SUPPORTED_DOCUMENT_EXTENSIONS.map(e => `.${e}`).join(",");

/**
 * Extract plain text from any supported document buffer.
 */
export async function extractTextFromDocument(
  buffer: Buffer,
  fileName: string,
): Promise<string> {
  const format = detectFormat(fileName);

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
  return text as string;
}

// ── EPUB ───────────────────────────────────────────────────────────────

async function extractEPUB(buffer: Buffer): Promise<string> {
  const EPub = (await import("epub2")).default;
  const fs = await import("fs");
  const path = await import("path");
  const os = await import("os");

  // epub2 requires a file path, not a buffer — write to temp file
  const tempDir = os.tmpdir();
  const tempPath = path.join(tempDir, `echomancer_epub_${Date.now()}.epub`);

  try {
    fs.writeFileSync(tempPath, buffer);

    const epub = await EPub.createAsync(tempPath);

    // Collect chapter text in reading order
    const chapters: string[] = [];

    // Use the flow (spine) which lists all content documents in reading order
    const flow: Array<{ id: string; href?: string; title?: string }> = (epub as any).flow || [];

    for (const item of flow) {
      if (!item.id) continue;
      try {
        const html = await epub.getChapterAsync(item.id);
        const plain = stripHtml(html);
        if (plain.trim()) {
          chapters.push(plain.trim());
        }
      } catch {
        // Skip chapters that fail to parse (e.g., images, stylesheets)
      }
    }

    if (chapters.length === 0) {
      throw new Error("Could not extract text from EPUB. The file may be empty or DRM-protected.");
    }

    return chapters.join("\n\n");
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

// ── DOCX ───────────────────────────────────────────────────────────────

async function extractDOCX(buffer: Buffer): Promise<string> {
  const mammoth = await import("mammoth");

  const result = await mammoth.extractRawText({ buffer });

  if (!result.value?.trim()) {
    throw new Error("Could not extract text from DOCX. The file may be empty or corrupted.");
  }

  return result.value;
}

// ── TXT ────────────────────────────────────────────────────────────────

function extractTXT(buffer: Buffer): Promise<string> {
  const text = buffer.toString("utf-8");
  if (!text.trim()) {
    throw new Error("The text file is empty.");
  }
  return Promise.resolve(text);
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

  return Promise.resolve(text);
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
    return text;
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
