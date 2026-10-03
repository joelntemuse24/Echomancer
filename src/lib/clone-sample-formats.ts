/**
 * Accepted clone-sample formats and the product ceiling.
 *
 * Kept free of Node imports so the voice picker can state the same rules the
 * upload routes enforce. Samples PUT straight to R2; Vercel's ~4.5MB function
 * body is irrelevant.
 *
 * Video containers are accepted because phones record voice memos as
 * video/mp4 (.mp4/.mov) and Drive hands audio back as video or
 * octet-stream. The browser decodes the audio track to WAV before the
 * sample is uploaded, so only the pick-time validation has to care.
 */

export const ALLOWED_CLONE_EXTENSIONS = [
  "wav",
  "mp3",
  "m4a",
  "aac",
  "flac",
  "opus",
  "ogg",
  "oga",
  "webm",
  "mp4",
  "m4v",
  "mov",
] as const;

const EXTENSION_CONTENT_TYPE: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  opus: "audio/ogg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  webm: "audio/webm",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
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
  "audio/flac",
  "audio/x-flac",
  "video/mp4",
  "video/webm",
  "video/quicktime",
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
  if (trimmed && ALLOWED_CLONE_MIME.has(trimmed)) return trimmed;
  if (extOk) return EXTENSION_CONTENT_TYPE[ext] || null;
  return null;
}

const VIDEO_CLONE_EXTENSIONS = new Set(["mp4", "m4v", "mov", "webm"]);

/**
 * True when the pick looks like a video container (name or MIME), not just
 * audio. The browser must decode the audio track before the sample is
 * uploaded — a video container the browser can't decode is rejected at the
 * pick instead of being sent raw.
 */
export function looksLikeVideoCloneSample(
  fileName: string,
  mimeType?: string | null
): boolean {
  if (VIDEO_CLONE_EXTENSIONS.has(extensionOfCloneSample(fileName))) return true;
  const mime = ((mimeType || "").split(";")[0] ?? "").trim().toLowerCase();
  return mime.startsWith("video/");
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
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/webm": "webm",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
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

function startsWithBytes(bytes: Uint8Array, magic: number[], offset = 0): boolean {
  if (bytes.length < offset + magic.length) return false;
  return magic.every((b, i) => bytes[offset + i] === b);
}

function asciiAt(bytes: Uint8Array, offset: number, len: number): string {
  let s = "";
  for (let i = offset; i < Math.min(bytes.length, offset + len); i++) {
    s += String.fromCharCode(bytes[i]!);
  }
  return s;
}

/**
 * Magic-byte sniff for a sample whose name and MIME are missing or lying
 * (Drive often says octet-stream). Returns the canonical extension, or null
 * when the bytes are not audio/video at all.
 */
export function sniffCloneSampleFormat(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;
  // RIFF....WAVE
  if (
    startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    asciiAt(bytes, 8, 4) === "WAVE"
  ) {
    return "wav";
  }
  if (asciiAt(bytes, 0, 4) === "OggS") {
    return asciiAt(bytes, 0, 512).includes("OpusHead") ? "opus" : "ogg";
  }
  if (asciiAt(bytes, 0, 4) === "fLaC") return "flac";
  // ISO-BMFF (m4a / mp4 / mov): size then "ftyp" at offset 4
  if (asciiAt(bytes, 4, 4) === "ftyp") return "m4a";
  // EBML header (webm / mkv)
  if (startsWithBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "webm";
  // ID3-tagged audio (mp3, sometimes aac)
  if (asciiAt(bytes, 0, 3) === "ID3") return "mp3";
  // Raw MPEG audio frame: mp3 layers II/III vs ADTS AAC
  if (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) {
    const layer = bytes[1]! & 0x06;
    if (layer === 0x00) return "aac";
    return "mp3";
  }
  return null;
}

/** Content-Type for a client-sniffed sample, for the presign when name and MIME lie. */
export function contentTypeForSniffedCloneSample(sniffed: string): string {
  return EXTENSION_CONTENT_TYPE[sniffed] || "application/octet-stream";
}

/**
 * Extensions AND MIME types for the picker's accept attribute. Extension-only
 * filters grey out Drive items whose extension was stripped; MIME-only ones
 * grey out the same file when Drive says octet-stream.
 */
export const SUPPORTED_CLONE_SAMPLE_ACCEPT = [
  ...ALLOWED_CLONE_EXTENSIONS.map((e) => `.${e}`),
  ...ALLOWED_CLONE_MIME,
].join(",");

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
