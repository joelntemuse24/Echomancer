/**
 * "Did the provider actually send audio?" checks.
 *
 * Upstream speech models occasionally answer HTTP 200 with a bare WAV header,
 * zero-filled samples, or a couple of bytes. Wrapping that in a container and
 * storing it looks like success everywhere downstream, so the user ends up with
 * a book full of silence and no error to explain it. Every path that consumes
 * provider bytes — preview, take-home sections, live stream windows — runs
 * {@link isEmptyOrSilentAudio} before it advances any cursor.
 */

/** Below this, no container can hold a usable fraction of a second of speech. */
export const MIN_AUDIBLE_BYTES = 256;

/** Real MP3 speech is larger than a header + a couple of frames. */
export const MIN_MP3_SPEECH_BYTES = 800;

const ID3 = [0x49, 0x44, 0x33];

function looksLikeMpegFrame(bytes: Uint8Array, offset = 0): boolean {
  if (offset + 2 > bytes.length) return false;
  return bytes[offset] === 0xff && ((bytes[offset + 1]! & 0xe0) === 0xe0);
}

function skipId3(bytes: Uint8Array): number {
  if (
    bytes.length >= 10 &&
    bytes[0] === ID3[0] &&
    bytes[1] === ID3[1] &&
    bytes[2] === ID3[2]
  ) {
    const size =
      ((bytes[6]! & 0x7f) << 21) |
      ((bytes[7]! & 0x7f) << 14) |
      ((bytes[8]! & 0x7f) << 7) |
      (bytes[9]! & 0x7f);
    return Math.min(bytes.length, 10 + size);
  }
  return 0;
}

function looksLikeNonSpeechContainer(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  const head = ascii(bytes, 0, Math.min(16, bytes.length)).trimStart();
  if (head.startsWith("<!DOCTYPE") || head.startsWith("<html") || head.startsWith("<?xml")) {
    return true;
  }
  if (head.startsWith("{") || head.startsWith("[")) {
    if (/[{[]\s*"/.test(head) || head.includes("error") || head.includes("message")) {
      return true;
    }
  }
  if (head.startsWith("%PDF")) return true;
  return false;
}

const WAV_HEADER_BYTES = 44;

function toUint8(buf: Uint8Array | Buffer): Uint8Array {
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end && i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i]!);
  }
  return out;
}

function isRiffWave(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 12) === "WAVE"
  );
}

/** Declared `data` chunk length of a WAV, or null when it cannot be read. */
function wavDataChunkLength(bytes: Uint8Array): number | null {
  if (!isRiffWave(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    if (id === "data") return size;
    offset += 8 + size + (size % 2);
  }
  return null;
}

/** True when every byte is zero — digital silence, whatever the container. */
export function isAllZeroBytes(buf: Uint8Array | Buffer): boolean {
  const bytes = toUint8(buf);
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) return false;
  }
  return true;
}

/**
 * True when the buffer cannot contain audible speech: too small, a WAV whose
 * `data` chunk is empty, or nothing but zeroed samples.
 */
export function isEmptyOrSilentAudio(
  buf: Uint8Array | Buffer | null | undefined,
  minBytes = MIN_AUDIBLE_BYTES
): boolean {
  if (!buf || buf.length < minBytes) return true;

  const bytes = toUint8(buf);

  if (looksLikeNonSpeechContainer(bytes)) return true;

  const declaredDataLength = wavDataChunkLength(bytes);
  if (declaredDataLength !== null) {
    if (declaredDataLength === 0) return true;
    const payload = bytes.subarray(WAV_HEADER_BYTES);
    return payload.length === 0 || isAllZeroBytes(payload);
  }

  const afterId3 = skipId3(bytes);
  const mp3Like = looksLikeMpegFrame(bytes, afterId3) || afterId3 > 0;
  if (mp3Like) {
    if (bytes.length < MIN_MP3_SPEECH_BYTES) return true;
    if (!looksLikeMpegFrame(bytes, afterId3) && afterId3 >= bytes.length - 4) {
      return true;
    }
    return false;
  }

  return isAllZeroBytes(bytes);
}

/**
 * Same question for a live stream: the header is emitted before any samples
 * arrive, so judge the concatenated payload rather than each chunk.
 */
export function isEmptyOrSilentStreamPayload(
  totalBytes: number,
  sawNonZeroByte: boolean,
  minBytes = MIN_AUDIBLE_BYTES
): boolean {
  return totalBytes < minBytes || !sawNonZeroByte;
}

/** Does this chunk contain at least one non-zero sample? */
export function hasNonZeroByte(buf: Uint8Array | Buffer): boolean {
  return !isAllZeroBytes(buf);
}
