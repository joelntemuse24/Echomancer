/**
 * ID3v2 header size arithmetic.
 *
 * The 7-bit "synchsafe" size at bytes 6–9 of an ID3 header appeared in seven
 * modules. These are the two shapes the pipeline actually needs.
 */

function unsynchsafe(byte0: number, byte1: number, byte2: number, byte3: number): number {
  return (
    ((byte0 & 0x7f) << 21) |
    ((byte1 & 0x7f) << 14) |
    ((byte2 & 0x7f) << 7) |
    (byte3 & 0x7f)
  );
}

/**
 * Total bytes of the leading ID3v2 tag, including the 10-byte header and an
 * optional 10-byte footer. `0` when there is no tag. Clamped to `length` so a
 * truncated tag never indexes past the buffer.
 */
export function id3v2TotalBytes(audio: Buffer | Uint8Array, length = audio.length): number {
  if (
    length < 10 ||
    audio[0] !== 0x49 ||
    audio[1] !== 0x44 ||
    audio[2] !== 0x33
  ) {
    return 0;
  }
  const size = unsynchsafe(audio[6]!, audio[7]!, audio[8]!, audio[9]!);
  const footer = (audio[5]! & 0x10) !== 0 ? 10 : 0;
  return Math.min(length, 10 + size + footer);
}

/** Synchsafe size at an arbitrary offset inside an ID3 frame header. */
export function unsynchsafeAt(audio: Buffer | Uint8Array, offset: number): number {
  return unsynchsafe(
    audio[offset]!,
    audio[offset + 1]!,
    audio[offset + 2]!,
    audio[offset + 3]!
  );
}
