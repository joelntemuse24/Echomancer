/**
 * Chapter marks inside the downloaded MP3.
 *
 * ffmpeg reads an ffmetadata1 file and stores each chapter as an ID3v2.3
 * CHAP frame (title in its TIT2 subframe). The mux is a packet copy, so it
 * adds one fast file pass and no extra encode generation.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";

export type Id3Chapter = { title: string; startMs: number; endMs: number };

/** ffmetadata1 escapes `=` `;` `#` `\` and cannot hold a newline. */
function escapeFfmetadata(value: string): string {
  return value.replace(/([=;#\\])/g, "\\$1").replace(/[\r\n]+/g, " ").trim();
}

/** Monotonic millisecond windows shared by ffmetadata and the ID3 tag. */
function timedChapters(
  chapters: Id3Chapter[]
): Array<{ title: string; startMs: number; endMs: number }> {
  let lastEnd = 0;
  return chapters.map((chapter) => {
    const start = Math.max(lastEnd, Math.round(chapter.startMs));
    const end = Math.max(start + 1, Math.round(chapter.endMs));
    lastEnd = end;
    return { title: chapter.title, startMs: start, endMs: end };
  });
}

export function ffmetadataForChapters(chapters: Id3Chapter[]): string {
  const lines = [";FFMETADATA1"];
  for (const chapter of timedChapters(chapters)) {
    lines.push(
      "[CHAPTER]",
      "TIMEBASE=1/1000",
      `START=${chapter.startMs}`,
      `END=${chapter.endMs}`,
      `title=${escapeFfmetadata(chapter.title) || "Chapter"}`
    );
  }
  return lines.join("\n") + "\n";
}

function synchsafeSize(size: number): Buffer {
  return Buffer.from([
    (size >>> 21) & 0x7f,
    (size >>> 14) & 0x7f,
    (size >>> 7) & 0x7f,
    size & 0x7f,
  ]);
}

function id3Frame(id: string, body: Buffer, flags = 0): Buffer {
  const header = Buffer.alloc(10);
  header.write(id, 0, "ascii");
  // ID3v2.3 frame sizes are plain 32-bit big-endian, not synchsafe.
  header.writeUInt32BE(body.length, 4);
  header.writeUInt16BE(flags, 8);
  return Buffer.concat([header, body]);
}

/** UTF-16 with BOM is valid in 2.3 and carries non-Latin chapter titles. */
function id3TextFrame(id: string, value: string): Buffer {
  return id3Frame(
    id,
    Buffer.concat([Buffer.from([0x01]), Buffer.from([0xff, 0xfe]), Buffer.from(value, "utf16le")])
  );
}

function nullTerminated(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, "ascii"), Buffer.from([0x00])]);
}

function chapterTitle(title: string): string {
  return title.replace(/[\r\n]+/g, " ").trim() || "Chapter";
}

function chapterFrame(
  id: string,
  title: string,
  startMs: number,
  endMs: number
): Buffer {
  const body = Buffer.alloc(16);
  body.writeUInt32BE(startMs, 0);
  body.writeUInt32BE(endMs, 4);
  body.writeUInt32BE(0xffffffff, 8);
  body.writeUInt32BE(0xffffffff, 12);
  return id3Frame(
    "CHAP",
    Buffer.concat([nullTerminated(id), body, id3TextFrame("TIT2", title)])
  );
}

/** Table of contents frame: top-level (0x02) and ordered (0x01). */
function tocFrame(ids: string[]): Buffer {
  return id3Frame(
    "CTOC",
    Buffer.concat([
      nullTerminated("toc"),
      Buffer.from([0x03, ids.length]),
      ...ids.map(nullTerminated),
      id3TextFrame("TIT2", "Chapters"),
    ])
  );
}

/**
 * ID3v2.3 tag with a CTOC table of contents and one CHAP frame per chapter,
 * so the tag can sit in front of an MP3 without rewriting its audio.
 */
export function buildId3ChapterTag(chapters: Id3Chapter[]): Buffer {
  if (chapters.length === 0) return Buffer.alloc(0);
  const timed = timedChapters(chapters);
  const ids = timed.map((_chapter, i) => `chp${i}`);
  const frames = Buffer.concat([
    tocFrame(ids),
    ...timed.map((chapter, i) =>
      chapterFrame(ids[i]!, chapterTitle(chapter.title), chapter.startMs, chapter.endMs)
    ),
  ]);
  const header = Buffer.concat([
    Buffer.from("ID3", "ascii"),
    Buffer.from([0x03, 0x00, 0x00]),
    synchsafeSize(frames.length),
  ]);
  return Buffer.concat([header, frames]);
}

/** Length in bytes of the MPEG audio frame at `offset`, or null if none. */
function mp3FrameBytes(head: Buffer, offset: number): number | null {
  if (offset + 4 > head.length) return null;
  if (head[offset] !== 0xff || (head[offset + 1]! & 0xe0) !== 0xe0) return null;
  const version = (head[offset + 1]! >> 3) & 0x3;
  const layer = (head[offset + 1]! >> 1) & 0x3;
  if (version === 1 || layer === 0) return null;
  const b2 = head[offset + 2]!;
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
  return length >= 4 ? length : null;
}

/**
 * Bytes an existing ID3 header occupies at the start of an MP3, including
 * any audio frames the source encoder already wrote. 0 when `head` is not
 * an ID3 tag. A leading Xing/Info frame is skipped too: its frame count and
 * TOC describe one source file, and a player that reads them at the head of
 * a concatenated book clamps every seek to a few seconds.
 */
export function id3v2HeaderBytes(head: Buffer): number {
  if (head.length < 10 || head.toString("ascii", 0, 3) !== "ID3") return 0;
  const size =
    ((head[6]! & 0x7f) << 21) |
    ((head[7]! & 0x7f) << 14) |
    ((head[8]! & 0x7f) << 7) |
    (head[9]! & 0x7f);
  const offset = 10 + size + (head[5]! & 0x10 ? 10 : 0);
  const frameLen = mp3FrameBytes(head, offset);
  if (frameLen == null || head.length < offset + frameLen) return offset;
  const frame = head.subarray(offset, offset + frameLen);
  if (frame.includes(Buffer.from("Xing")) || frame.includes(Buffer.from("Info"))) {
    return offset + frameLen;
  }
  return offset;
}

/**
 * Write `destPath` as `srcPath` plus chapter metadata. Throws on ffmpeg
 * failure; the caller ships the original file instead.
 */
export async function muxChaptersIntoMp3(opts: {
  run: (args: string[], timeoutMs: number) => Promise<void>;
  srcPath: string;
  destPath: string;
  workDir: string;
  chapters: Id3Chapter[];
  timeoutMs?: number;
}): Promise<void> {
  const metaPath = path.join(opts.workDir, "chapters.ffmeta");
  await writeFile(metaPath, ffmetadataForChapters(opts.chapters), "utf8");
  await opts.run(
    [
      "-y",
      "-i",
      opts.srcPath,
      "-i",
      metaPath,
      "-map",
      "0:a",
      "-map_metadata",
      "1",
      "-map_chapters",
      "1",
      "-c",
      "copy",
      "-id3v2_version",
      "3",
      opts.destPath,
    ],
    opts.timeoutMs ?? 300_000
  );
}
