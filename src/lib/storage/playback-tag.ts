/**
 * Playback view of a finished book, with the leading ID3 tag left off.
 *
 * The stored `full.mp3` keeps its chapter tag. Download still sends that
 * object. The `<audio>` element does not. Chrome's MP3 demuxer skips the
 * tag on the first open, then a seek back to zero scans from the start of
 * the buffered bytes. Chapter titles are UTF-16, so the tag contains
 * `FF FE` byte pairs. Those parse as MPEG-1 Layer I frames (140 bytes at
 * `FF FE 43 00`, 172 bytes at `FF FE 50 00`). Symphonia then stops the
 * pipeline with "unexpected end of bitstream". The same file with the tag
 * removed seeks back to zero and keeps playing. Measured on a frame-trimmed
 * prefix in Chrome 156: first play succeeded either way; seek-to-zero
 * raised media error 3 only while the tag was still at byte 0.
 */

import { id3v2TotalBytes } from "@/lib/tts/id3-size";
import { parseByteRange, type ByteRange } from "@/lib/storage/byte-range";

/** A chapter tag is a few kilobytes. A larger claimed size is not one of ours. */
export const MAX_PLAYBACK_TAG_BYTES = 1024 * 1024;

export type PlaybackTag = { fileSize: number; tagBytes: number };

/**
 * Bytes to hide at the start of a playback response. `0` leaves the object
 * unchanged: no tag, a tag that claims the whole file, or a tag past the cap.
 */
export function playbackTagLength(header: Uint8Array, fileSize: number): number {
  const tag = id3v2TotalBytes(header, fileSize);
  if (tag <= 0 || tag >= fileSize || tag > MAX_PLAYBACK_TAG_BYTES) return 0;
  return tag;
}

export type ShiftedPlaybackRange = {
  fileRange: string;
  contentRange: string;
  contentLength: number;
};

/**
 * Map a client range onto the stored object.
 *
 * The client counts from the first audio byte. The object counts from the
 * start of the tag. `clientRange` is already capped to one playback window.
 */
export function shiftClientRange(
  clientRange: string,
  tag: PlaybackTag
): ShiftedPlaybackRange | "unsatisfiable" {
  const audioSize = tag.fileSize - tag.tagBytes;
  const parsed = parseByteRange(clientRange, audioSize);
  if (parsed === "unsatisfiable" || parsed === null) return "unsatisfiable";
  return shiftParsedRange(parsed, tag, audioSize);
}

const leadingTagCache = new Map<string, PlaybackTag>();

export function recallPlaybackTag(key: string): PlaybackTag | undefined {
  return leadingTagCache.get(key);
}

export function rememberPlaybackTag(key: string, tag: PlaybackTag): void {
  leadingTagCache.set(key, tag);
}

export function clearPlaybackTagCache(): void {
  leadingTagCache.clear();
}

/** First bytes of a probe stream. Cancels the rest so the socket can close. */
export async function readPrefix(
  body: ReadableStream<Uint8Array>,
  max: number
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  try {
    while (got < max) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      got += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(Math.min(got, max));
  let offset = 0;
  for (const chunk of chunks) {
    const n = Math.min(chunk.byteLength, out.byteLength - offset);
    out.set(chunk.subarray(0, n), offset);
    offset += n;
    if (offset >= out.byteLength) break;
  }
  return out;
}

/** Total object size from a probe of the first bytes, or null if it is not. */
export function fileSizeFromProbeRange(contentRange: string | undefined): number | null {
  const match = /^bytes 0-\d+\/(\d+)$/.exec(contentRange ?? "");
  if (!match?.[1]) return null;
  const size = Number(match[1]);
  return Number.isFinite(size) && size > 0 ? size : null;
}

function shiftParsedRange(
  parsed: ByteRange,
  tag: PlaybackTag,
  audioSize: number
): ShiftedPlaybackRange {
  const fileStart = parsed.start + tag.tagBytes;
  const fileEnd = parsed.end + tag.tagBytes;
  return {
    fileRange: `bytes=${fileStart}-${fileEnd}`,
    contentRange: `bytes ${parsed.start}-${parsed.end}/${audioSize}`,
    contentLength: parsed.end - parsed.start + 1,
  };
}
