/**
 * Convert raw PCM (L16) to WAV so browsers can play it in <audio>.
 * Gemini TTS (direct + OpenRouter) returns raw PCM at 24 kHz mono.
 */

export const PCM_DEFAULTS = {
  sampleRate: 24_000,
  numChannels: 1,
  bitDepth: 16,
} as const;

export type PcmWavOptions = {
  sampleRate?: number;
  numChannels?: number;
  bitDepth?: number;
};

export function isRawPcmContentType(contentType: string | undefined | null): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return (
    ct.includes("audio/pcm") ||
    ct.includes("audio/l16") ||
    ct.includes("audio/raw") ||
    ct.includes("l16")
  );
}

/** Detect container from magic bytes — don't trust Content-Type alone. */
export function sniffAudioContentType(buf: Buffer): string | null {
  if (buf.length < 4) return null;
  // RIFF....WAVE
  if (
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.length >= 12 &&
    buf.toString("ascii", 8, 12) === "WAVE"
  ) {
    return "audio/wav";
  }
  // OggS
  if (buf.toString("ascii", 0, 4) === "OggS") return "audio/ogg";
  // ID3 tag or MPEG frame sync
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return "audio/mpeg";
  if (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0) return "audio/mpeg";
  return null;
}

/** Parse sample rate from mime like `audio/L16;rate=24000`. */
export function sampleRateFromContentType(
  contentType: string | undefined | null,
  fallback = PCM_DEFAULTS.sampleRate
): number {
  if (!contentType) return fallback;
  const match = contentType.match(/rate\s*=\s*(\d+)/i);
  if (match?.[1]) {
    const rate = Number(match[1]);
    if (Number.isFinite(rate) && rate > 0) return rate;
  }
  return fallback;
}

/**
 * Build a 44-byte RIFF/WAVE header for PCM (format=1).
 * dataByteLength may be an estimate (e.g. 0x7FFFFFFF) for streaming.
 */
export function createWavHeader(
  dataByteLength: number,
  opts: PcmWavOptions = {}
): Buffer {
  const sampleRate = opts.sampleRate ?? PCM_DEFAULTS.sampleRate;
  const numChannels = opts.numChannels ?? PCM_DEFAULTS.numChannels;
  const bitDepth = opts.bitDepth ?? PCM_DEFAULTS.bitDepth;
  const byteRate = (sampleRate * numChannels * bitDepth) / 8;
  const blockAlign = (numChannels * bitDepth) / 8;
  const safeDataLen = Math.max(0, Math.min(dataByteLength, 0x7fffffff));

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + safeDataLen, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write("data", 36);
  header.writeUInt32LE(safeDataLen, 40);
  return header;
}

/** Wrap raw PCM samples in a complete WAV buffer. */
export function pcmToWav(pcm: Buffer, opts: PcmWavOptions = {}): Buffer {
  const header = createWavHeader(pcm.length, opts);
  return Buffer.concat([header, pcm]);
}

/**
 * If content is raw PCM, wrap as WAV for browser playback.
 * Otherwise return unchanged.
 */
export function ensureBrowserPlayable(
  audio: Buffer,
  contentType: string
): { audio: Buffer; contentType: string } {
  if (!isRawPcmContentType(contentType)) {
    return { audio, contentType };
  }
  const sampleRate = sampleRateFromContentType(contentType);
  return {
    audio: pcmToWav(audio, { sampleRate }),
    contentType: "audio/wav",
  };
}

/**
 * Strip RIFF/WAVE header(s) and return PCM payload for safe concatenation.
 * If the buffer is not a WAV, returns it unchanged.
 */
export function stripWavHeader(buf: Buffer): Buffer {
  if (buf.length < 44) return buf;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return buf;
  if (buf.toString("ascii", 8, 12) !== "WAVE") return buf;

  // Walk chunks to find "data"
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (id === "data") {
      const end = Math.min(dataStart + size, buf.length);
      return buf.subarray(dataStart, end);
    }
    // Chunks are word-aligned
    offset = dataStart + size + (size % 2);
  }
  // Fallback: assume canonical 44-byte header
  return buf.subarray(44);
}
