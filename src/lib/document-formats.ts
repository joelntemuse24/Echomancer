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
 * Upload ceiling in megabytes. The server reads `MAX_UPLOAD_MB`; the browser can
 * only see the `NEXT_PUBLIC_` copy, so both are consulted and they should be set
 * to the same value.
 */
export function maxUploadMb(): number {
  const configured = Number(
    process.env.MAX_UPLOAD_MB || process.env.NEXT_PUBLIC_MAX_UPLOAD_MB || "25"
  );
  return Number.isFinite(configured) && configured > 0 ? configured : 25;
}

export function maxUploadBytes(): number {
  return maxUploadMb() * 1024 * 1024;
}
