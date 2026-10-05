/**
 * Replace ID3 chapter frames without moving the audio.
 *
 * The tag size stays what the file already reserved. New CHAP frames and a
 * CTOC that lists them are written into that span, and the rest is padding.
 * ID3v2.3 frame sizes are plain integers. ID3v2.4 frame sizes are syncsafe.
 * A tag that is too small, unsynchronised, or missing is left untouched —
 * shifting `full.mp3` to grow the header is a full rewrite. The caller only
 * does this for a local file.
 */

export type InplaceChapter = { title: string; startMs: number; endMs: number };

export type Id3Rewrite =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: string };

function unsynchsafe(audio: Buffer, offset: number): number {
  return (
    ((audio[offset]! & 0x7f) << 21) |
    ((audio[offset + 1]! & 0x7f) << 14) |
    ((audio[offset + 2]! & 0x7f) << 7) |
    (audio[offset + 3]! & 0x7f)
  );
}

function writeFrameSize(header: Buffer, size: number, major: number): void {
  if (major === 4) {
    header[4] = (size >> 21) & 0x7f;
    header[5] = (size >> 14) & 0x7f;
    header[6] = (size >> 7) & 0x7f;
    header[7] = size & 0x7f;
    return;
  }
  header.writeUInt32BE(size, 4);
}

function frame(id: string, body: Buffer, major: number): Buffer {
  const header = Buffer.alloc(10);
  header.write(id, 0, 4, "ascii");
  writeFrameSize(header, body.length, major);
  return Buffer.concat([header, body]);
}

function textFrame(id: string, value: string, major: number): Buffer {
  const safe = value.replace(/\0/g, "").replace(/[\r\n]+/g, " ").trim() || "Chapter";
  const latin = [...safe].every((ch) => ch.charCodeAt(0) <= 255);
  if (latin) {
    return frame(id, Buffer.concat([Buffer.from([0]), Buffer.from(safe, "latin1")]), major);
  }
  const chars = Buffer.alloc(3 + safe.length * 2);
  chars[0] = 1;
  chars.writeUInt16BE(0xfeff, 1);
  for (let i = 0; i < safe.length; i++) chars.writeUInt16BE(safe.charCodeAt(i), 3 + i * 2);
  return frame(id, chars, major);
}

function chapterElementId(index: number): string {
  return `ch${index}`;
}

function chapterFrame(index: number, chapter: InplaceChapter, major: number): Buffer {
  const element = Buffer.from(`${chapterElementId(index)}\0`, "latin1");
  const times = Buffer.alloc(16);
  const start = Math.max(0, Math.round(chapter.startMs));
  const end = Math.max(start + 1, Math.round(chapter.endMs));
  times.writeUInt32BE(start, 0);
  times.writeUInt32BE(end, 4);
  times.writeUInt32BE(0xffffffff, 8);
  times.writeUInt32BE(0xffffffff, 12);
  return frame("CHAP", Buffer.concat([element, times, textFrame("TIT2", chapter.title, major)]), major);
}

/** Top-level ordered table of contents pointing at the chapter element ids. */
function tocFrame(chapters: InplaceChapter[], major: number): Buffer {
  const ids = chapters.slice(0, 255).map((_, index) => chapterElementId(index));
  const children = Buffer.concat(ids.map((id) => Buffer.from(`${id}\0`, "latin1")));
  const body = Buffer.concat([Buffer.from("toc\0", "latin1"), Buffer.from([0x03, ids.length]), children]);
  return frame("CTOC", body, major);
}

function isFrameId(audio: Buffer, offset: number): boolean {
  if (offset + 4 > audio.length) return false;
  for (let i = 0; i < 4; i++) {
    const code = audio[offset + i]!;
    const ok = (code >= 65 && code <= 90) || (code >= 48 && code <= 57);
    if (!ok) return false;
  }
  return true;
}

/**
 * Build a same-length ID3 header with these chapters.
 * `fileHead` must include the existing tag. The returned bytes are only
 * the tag; the caller writes them at offset 0.
 */
export function rewriteId3ChapterHeader(fileHead: Buffer, chapters: InplaceChapter[]): Id3Rewrite {
  if (!chapters.length) return { ok: false, reason: "no chapters to write" };
  if (fileHead.length < 10 || fileHead.toString("ascii", 0, 3) !== "ID3") {
    return { ok: false, reason: "no ID3v2 header to rewrite in place" };
  }
  const major = fileHead[3]!;
  if (major !== 3 && major !== 4) {
    return { ok: false, reason: `ID3v2.${major} chapter rewrite is not supported` };
  }
  const flags = fileHead[5]!;
  if ((flags & 0x80) !== 0) return { ok: false, reason: "unsynchronised ID3 tag was left unchanged" };
  if ((flags & 0x40) !== 0) return { ok: false, reason: "ID3 extended header was left unchanged" };
  const bodySize = unsynchsafe(fileHead, 6);
  const tagSize = 10 + bodySize;
  if (tagSize > fileHead.length) {
    return { ok: false, reason: "ID3 tag continues past the bytes that were read" };
  }

  const kept: Buffer[] = [];
  let offset = 10;
  const end = tagSize;
  while (offset + 10 <= end && isFrameId(fileHead, offset)) {
    const id = fileHead.toString("ascii", offset, offset + 4);
    const size = major === 4 ? unsynchsafe(fileHead, offset + 4) : fileHead.readUInt32BE(offset + 4);
    if (size < 0 || offset + 10 + size > end) break;
    // The old chapter frames name element ids this rewrite replaces.
    // A new CTOC is written below so the table of contents stays in the tag.
    if (id !== "CHAP" && id !== "CTOC") {
      kept.push(fileHead.subarray(offset, offset + 10 + size));
    }
    offset += 10 + size;
  }

  const next = Buffer.concat([
    ...kept,
    tocFrame(chapters, major),
    ...chapters.map((chapter, index) => chapterFrame(index, chapter, major)),
  ]);
  if (next.length > bodySize) {
    return {
      ok: false,
      reason: "chapter tag does not fit in the existing ID3 padding",
    };
  }
  const out = Buffer.alloc(tagSize);
  fileHead.copy(out, 0, 0, 10);
  next.copy(out, 10);
  return { ok: true, bytes: out };
}
