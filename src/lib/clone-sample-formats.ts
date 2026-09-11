/**
 * Accepted clone-sample formats and the product ceiling.
 *
 * Kept free of Node imports so the voice picker can state the same rules the
 * upload routes enforce. Samples PUT straight to R2; Vercel’s ~4.5MB function
 * body is irrelevant.
 */

export const ALLOWED_CLONE_EXTENSIONS = [
  "wav",
  "mp3",
  "m4a",
  "opus",
  "ogg",
  "webm",
] as const;

const EXTENSION_CONTENT_TYPE: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  opus: "audio/ogg",
  ogg: "audio/ogg",
  webm: "audio/webm",
};

const ALLOWED_CLONE_MIME = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/ogg",
  "audio/opus",
  "audio/webm",
]);

/** Uncompressed ~2 min stereo 48 kHz 16-bit is ~22 MB; 32 MB is the ceiling. */
export const DEFAULT_MAX_CLONE_SAMPLE_MB = 32;

/** Reject empty/tiny uploads (~8 KB). */
export const MIN_CLONE_SAMPLE_BYTES = 8 * 1024;

export function extensionOfCloneSample(name: string): string {
  const parts = name.toLowerCase().split(".");
  return parts.length > 1 ? parts[parts.length - 1]! : "";
}

export function isAllowedCloneSample(
  fileName: string,
  contentType?: string
): boolean {
  return contentTypeForCloneSample(fileName, contentType) !== null;
}

/**
 * Content-Type the browser must send on the presigned PUT, or null when the
 * file is not an accepted audio sample.
 */
export function contentTypeForCloneSample(
  fileName: string,
  declared?: string
): string | null {
  const ext = extensionOfCloneSample(fileName);
  const extOk = (ALLOWED_CLONE_EXTENSIONS as readonly string[]).includes(ext);
  const trimmed = declared?.trim().toLowerCase();

  if (trimmed && trimmed.startsWith("audio/")) {
    if (extOk || ALLOWED_CLONE_MIME.has(trimmed)) return trimmed;
  }
  if (extOk) return EXTENSION_CONTENT_TYPE[ext] || null;
  return null;
}

const MIME_TO_EXTENSION: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "m4a",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/webm": "webm",
};

/** Single allowlisted suffix for `clones/<id>/sample.<ext>` — never the raw name. */
export function safeCloneSampleExtension(
  fileName: string,
  declared?: string
): string {
  const ext = extensionOfCloneSample(fileName);
  if ((ALLOWED_CLONE_EXTENSIONS as readonly string[]).includes(ext)) return ext;
  const fromMime = MIME_TO_EXTENSION[declared?.trim().toLowerCase() || ""];
  return fromMime || "mp3";
}

export function maxCloneSampleMb(): number {
  const configured = Number(
    process.env.MAX_CLONE_SAMPLE_MB ||
      process.env.NEXT_PUBLIC_MAX_CLONE_SAMPLE_MB ||
      String(DEFAULT_MAX_CLONE_SAMPLE_MB)
  );
  const value =
    Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_MAX_CLONE_SAMPLE_MB;
  return Math.min(value, DEFAULT_MAX_CLONE_SAMPLE_MB);
}

export function maxCloneSampleBytes(): number {
  return maxCloneSampleMb() * 1024 * 1024;
}
