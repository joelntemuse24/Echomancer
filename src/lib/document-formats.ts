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
  "application/epub+zip": "epub",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/msword": "docx",
  "text/plain": "txt",
  "application/rtf": "rtf",
  "text/rtf": "rtf",
  "application/x-mobipocket-ebook": "mobi",
};

export const SUPPORTED_DOCUMENT_EXTENSIONS = Object.keys(EXTENSION_FORMATS);

export const SUPPORTED_DOCUMENT_ACCEPT = SUPPORTED_DOCUMENT_EXTENSIONS.map(
  (e) => `.${e}`
).join(",");

export function detectFormat(
  fileName: string,
  mimeType?: string
): DocumentFormat {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  if (EXTENSION_FORMATS[ext]) return EXTENSION_FORMATS[ext];
  if (mimeType && MIME_FORMATS[mimeType]) return MIME_FORMATS[mimeType];
  return "unknown";
}

export function isSupportedDocument(file: {
  name: string;
  type?: string;
}): boolean {
  return detectFormat(file.name, file.type) !== "unknown";
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
  const trimmed = declared?.trim();
  if (
    trimmed &&
    trimmed !== "application/octet-stream" &&
    MIME_FORMATS[trimmed]
  ) {
    return trimmed;
  }
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  return EXTENSION_CONTENT_TYPE[ext] || trimmed || "application/octet-stream";
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
