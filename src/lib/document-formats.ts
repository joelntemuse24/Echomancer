/**
 * Accepted document formats and the upload ceiling.
 *
 * Kept free of Node imports so the landing page can state the same rules the
 * upload route enforces. When these lived only in `text-extraction.ts` (which
 * dynamically imports `fs`, `unpdf`, `mammoth`) the client could not share them,
 * and the two drifted — the UI advertised 100MB while the server rejected less.
 */

export type DocumentFormat =
  | "pdf"
  | "epub"
  | "docx"
  | "txt"
  | "rtf"
  | "mobi"
  | "unknown";

export const EXTENSION_FORMATS: Record<string, DocumentFormat> = {
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

export const MIME_FORMATS: Record<string, DocumentFormat> = {
  "application/pdf": "pdf",
  "application/x-pdf": "pdf",
  "application/acrobat": "pdf",
  "application/vnd.pdf": "pdf",
  "text/pdf": "pdf",
  "application/epub+zip": "epub",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/msword": "docx",
  "text/plain": "txt",
  "text/txt": "txt",
  "application/rtf": "rtf",
  "text/rtf": "rtf",
  "application/x-mobipocket-ebook": "mobi",
};

export const SUPPORTED_DOCUMENT_EXTENSIONS = Object.keys(EXTENSION_FORMATS);

export const SUPPORTED_DOCUMENT_ACCEPT = SUPPORTED_DOCUMENT_EXTENSIONS.map(
  (e) => `.${e}`
).join(",");

/** Strip charset / boundary parameters so `application/pdf; charset=binary` still matches. */
export function normalizeMimeType(mimeType?: string | null): string {
  return (mimeType || "").split(";")[0].trim().toLowerCase();
}

export function detectFormat(
  fileName: string,
  mimeType?: string
): DocumentFormat {
  const base = fileName.split(/[/\\]/).pop() || fileName;
  const ext = base.includes(".")
    ? base.split(".").pop()?.toLowerCase() || ""
    : "";
  if (ext && EXTENSION_FORMATS[ext]) return EXTENSION_FORMATS[ext];
  const mime = normalizeMimeType(mimeType);
  if (mime && MIME_FORMATS[mime]) return MIME_FORMATS[mime];
  return "unknown";
}

function startsWithBytes(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((b, i) => bytes[i] === b);
}

function latin1Head(bytes: Uint8Array, max = 64_000): string {
  const n = Math.min(bytes.length, max);
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

function sniffZipDocument(bytes: Uint8Array): DocumentFormat | null {
  const head = latin1Head(bytes, Math.min(bytes.length, 512_000));
  if (head.includes("word/document.xml") || head.includes("word/")) {
    return "docx";
  }
  if (
    head.includes("META-INF/container.xml") ||
    head.includes("application/epub+zip")
  ) {
    return "epub";
  }
  return null;
}

/** Magic-byte sniff so a valid PDF/DOCX is not rejected for a missing extension or odd MIME. */
export function sniffDocumentFormat(
  bytes: Uint8Array,
  fileName: string,
  mimeType?: string
): DocumentFormat {
  if (startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46])) return "pdf"; // %PDF
  if (latin1Head(bytes, 16).includes("{\\rtf")) return "rtf";
  if (startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const zip = sniffZipDocument(bytes);
    if (zip) return zip;
  }
  const named = detectFormat(fileName, mimeType);
  if (named !== "unknown") return named;
  if (startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    return sniffZipDocument(bytes) || "unknown";
  }
  return named;
}

/** Presign may not have bytes yet — allow octet-stream so extract can sniff. */
export function isAcceptableUploadDeclaration(
  fileName: string,
  mimeType?: string
): boolean {
  if (detectFormat(fileName, mimeType) !== "unknown") return true;
  const mime = normalizeMimeType(mimeType);
  return (
    !mime ||
    mime === "application/octet-stream" ||
    mime === "binary/octet-stream"
  );
}

export function isSupportedDocument(file: {
  name: string;
  type?: string;
}): boolean {
  return isAcceptableUploadDeclaration(file.name, file.type);
}

/**
 * Product ceiling for a whole book / phone scan. R2’s single PUT is far larger;
 * Vercel’s ~4.5MB function body is irrelevant because the browser PUTs to R2.
 */
export const DEFAULT_MAX_UPLOAD_MB = 512;

/**
 * JSON/presign bodies on Vercel must stay under the Hobby function payload cap
 * (~4.5MB). File bytes never use this path.
 */
export const VERCEL_FUNCTION_BODY_LIMIT_BYTES = 4_500_000;

const EXTENSION_CONTENT_TYPE: Record<string, string> = {
  pdf: "application/pdf",
  epub: "application/epub+zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  txt: "text/plain",
  text: "text/plain",
  rtf: "application/rtf",
  mobi: "application/x-mobipocket-ebook",
  azw: "application/x-mobipocket-ebook",
  azw3: "application/x-mobipocket-ebook",
  azw4: "application/x-mobipocket-ebook",
};

/** Content-Type the browser must send on the presigned PUT (must match the signature). */
export function contentTypeForDocument(
  fileName: string,
  declared?: string
): string {
  const format = detectFormat(fileName, declared);
  if (format !== "unknown") return canonicalContentType(format);
  const mime = normalizeMimeType(declared);
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  return EXTENSION_CONTENT_TYPE[ext] || mime || "application/octet-stream";
}

function canonicalContentType(format: DocumentFormat): string {
  switch (format) {
    case "pdf":
      return "application/pdf";
    case "epub":
      return "application/epub+zip";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "txt":
      return "text/plain";
    case "rtf":
      return "application/rtf";
    case "mobi":
      return "application/x-mobipocket-ebook";
    default:
      return "application/octet-stream";
  }
}

/**
 * Upload ceiling in megabytes. The server reads `MAX_UPLOAD_MB`; the browser can
 * only see the `NEXT_PUBLIC_` copy, so both are consulted and they should be set
 * to the same value.
 */
export function maxUploadMb(): number {
  const configured = Number(
    process.env.MAX_UPLOAD_MB ||
      process.env.NEXT_PUBLIC_MAX_UPLOAD_MB ||
      String(DEFAULT_MAX_UPLOAD_MB)
  );
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_UPLOAD_MB;
}

export function maxUploadBytes(): number {
  return maxUploadMb() * 1024 * 1024;
}
