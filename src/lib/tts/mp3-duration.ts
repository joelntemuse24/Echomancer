/**
 * MP3 duration from frames, not from file size.
 *
 * A Xing or LAME Info header's frame count is the file duration
 * (`frames × samples per frame / sample rate`). Without that header the
 * same answer is the sum of each frame. ID3 bytes and encoder padding are
 * not audio, so a 128 kbps size estimate runs long.
 */

export type Mp3Frame = {
  samples: number;
  sampleRate: number;
  length: number;
  layer: number;
  version: number;
  mono: boolean;
};

function id3v2Size(audio: Buffer): number | null {
  if (audio.length < 10 || audio.toString("ascii", 0, 3) !== "ID3") return null;
  const size =
    ((audio[6]! & 0x7f) << 21) |
    ((audio[7]! & 0x7f) << 14) |
    ((audio[8]! & 0x7f) << 7) |
    (audio[9]! & 0x7f);
  const footer = (audio[5]! & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

export function mp3FrameAt(audio: Buffer, offset: number): Mp3Frame | null {
  if (offset < 0 || offset + 4 > audio.length) return null;
  if (audio[offset] !== 0xff || (audio[offset + 1]! & 0xe0) !== 0xe0) return null;
  const version = (audio[offset + 1]! >> 3) & 0x3;
  const layer = (audio[offset + 1]! >> 1) & 0x3;
  if (version === 1 || layer === 0) return null;
  const b2 = audio[offset + 2]!;
  const bitrateIndex = (b2 >> 4) & 0xf;
  const sampleIndex = (b2 >> 2) & 0x3;
  const padding = (b2 >> 1) & 0x1;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) return null;
  const mpeg1 = version === 3;
  const layer1 = layer === 3;
  const rates = mpeg1
    ? layer1
      ? [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0]
      : layer === 2
        ? [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0]
        : [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
    : layer1
      ? [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
  const bitrate = rates[bitrateIndex] ?? 0;
  const base = [44100, 48000, 32000][sampleIndex] ?? 0;
  const sampleRate = mpeg1 ? base : version === 2 ? base / 2 : base / 4;
  if (!bitrate || !sampleRate) return null;
  const samples = layer1 ? 384 : mpeg1 || layer === 2 ? 1152 : 576;
  const length = layer1
    ? Math.floor((12 * bitrate * 1000) / sampleRate + padding) * 4
    : Math.floor((samples * bitrate * 1000) / (8 * sampleRate) + padding);
  if (length < 4 || offset + length > audio.length) return null;
  const mono = ((audio[offset + 3]! >> 6) & 0x3) === 3;
  return { samples, sampleRate, length, layer, version, mono };
}

function firstFrame(audio: Buffer, from: number): { offset: number; frame: Mp3Frame } | null {
  const end = audio.length - 4;
  for (let i = from; i <= end; i++) {
    const frame = mp3FrameAt(audio, i);
    if (!frame) continue;
    const next = mp3FrameAt(audio, i + frame.length);
    if (i + frame.length < audio.length - 1 && !next) continue;
    return { offset: i, frame };
  }
  return null;
}

/** Frame count stored in a Xing or LAME Info header, including that header frame. */
export function xingFrameCount(audio: Buffer, offset: number, frame: Mp3Frame): number | null {
  if (frame.layer !== 1) return null;
  const mpeg1 = frame.version === 3;
  const side = mpeg1 ? (frame.mono ? 17 : 32) : frame.mono ? 9 : 17;
  const at = offset + 4 + side;
  if (at + 8 > audio.length || at + 8 > offset + frame.length) return null;
  const tag = audio.toString("ascii", at, at + 4);
  if (tag !== "Xing" && tag !== "Info") return null;
  const flags = audio.readUInt32BE(at + 4);
  if ((flags & 0x1) === 0 || at + 12 > audio.length) return null;
  const frames = audio.readUInt32BE(at + 8);
  return frames > 0 ? frames : null;
}

function openAudio(audio: Buffer): { offset: number; frame: Mp3Frame } | null {
  if (!audio || audio.length < 4) return null;
  const tagEnd = id3v2Size(audio);
  if (tagEnd != null && tagEnd > audio.length) return null;
  return firstFrame(audio, tagEnd ?? 0);
}

/**
 * Duration from a Xing or Info frame count. A short prefix is enough.
 * Returns null when the header does not declare a frame count, so a partial
 * download is never treated as the whole file.
 */
export function mp3DeclaredDurationSeconds(audio: Buffer): number | null {
  const found = openAudio(audio);
  if (!found) return null;
  const declared = xingFrameCount(audio, found.offset, found.frame);
  if (!declared) return null;
  return (declared * found.frame.samples) / found.frame.sampleRate;
}

/**
 * Duration of one complete MP3. A Xing or Info frame count wins; otherwise
 * every frame is summed. Do not pass a prefix that cuts the file off.
 */
export function mp3DurationSeconds(audio: Buffer): number | null {
  const found = openAudio(audio);
  if (!found) return null;
  const declared = xingFrameCount(audio, found.offset, found.frame);
  if (declared) return (declared * found.frame.samples) / found.frame.sampleRate;

  let offset = found.offset;
  let seconds = 0;
  let frames = 0;
  let steps = 0;
  while (offset + 4 <= audio.length && steps < audio.length) {
    steps += 1;
    const frame = mp3FrameAt(audio, offset);
    if (!frame) {
      offset += 1;
      continue;
    }
    const nextAt = offset + frame.length;
    if (nextAt < audio.length - 1 && !mp3FrameAt(audio, nextAt)) {
      offset += 1;
      continue;
    }
    seconds += frame.samples / frame.sampleRate;
    frames += 1;
    offset = nextAt;
  }
  return frames > 0 ? seconds : null;
}
