import { describe, expect, it } from "vitest";
import { rewriteId3ChapterHeader } from "./id3-inplace";

function synchsafe(size: number, major = 3): Buffer {
  const header = Buffer.alloc(10, 0);
  header.write("ID3", 0, "ascii");
  header[3] = major;
  header[6] = (size >> 21) & 0x7f;
  header[7] = (size >> 14) & 0x7f;
  header[8] = (size >> 7) & 0x7f;
  header[9] = size & 0x7f;
  return header;
}

function syncsafeSize(size: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes[0] = (size >> 21) & 0x7f;
  bytes[1] = (size >> 14) & 0x7f;
  bytes[2] = (size >> 7) & 0x7f;
  bytes[3] = size & 0x7f;
  return bytes;
}

function beSize(size: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(size, 0);
  return bytes;
}

function unsynchsafe(bytes: Buffer): number {
  return ((bytes[0]! & 0x7f) << 21) | ((bytes[1]! & 0x7f) << 14) | ((bytes[2]! & 0x7f) << 7) | (bytes[3]! & 0x7f);
}

function frameSizeBytes(tag: Buffer, id: string, major: number): Buffer | null {
  const bodySize = unsynchsafe(tag.subarray(6, 10));
  let offset = 10;
  const end = 10 + bodySize;
  while (offset + 10 <= end) {
    const frameId = tag.toString("ascii", offset, offset + 4);
    if (!/^[A-Z0-9]{4}$/.test(frameId)) break;
    const sizeBytes = tag.subarray(offset + 4, offset + 8);
    const size = major === 4 ? unsynchsafe(sizeBytes) : sizeBytes.readUInt32BE(0);
    if (frameId === id) return Buffer.from(sizeBytes);
    if (offset + 10 + size > end) break;
    offset += 10 + size;
  }
  return null;
}

function tit2(title: string): Buffer {
  const body = Buffer.concat([Buffer.from([0]), Buffer.from(title, "latin1")]);
  const frame = Buffer.alloc(10 + body.length);
  frame.write("TIT2", 0, "ascii");
  frame.writeUInt32BE(body.length, 4);
  body.copy(frame, 10);
  return frame;
}

function tag(body: Buffer, padding: number, major = 3): Buffer {
  return Buffer.concat([
    synchsafe(body.length + padding, major),
    body,
    Buffer.alloc(padding, 0),
    Buffer.from([0xff, 0xfb]),
  ]);
}

describe("rewriteId3ChapterHeader", () => {
  it("rewrites chapters inside the existing tag and leaves the audio in place", () => {
    const file = tag(tit2("History"), 4096);
    const tagLength = file.length - 2;
    const rewritten = rewriteId3ChapterHeader(file.subarray(0, tagLength), [
      { title: `Part One ${"word ".repeat(40)}`, startMs: 0, endMs: 1000 },
      { title: "Part Two", startMs: 1000, endMs: 2500 },
    ]);
    expect(rewritten.ok).toBe(true);
    if (!rewritten.ok) return;
    expect(rewritten.bytes.length).toBe(tagLength);
    expect(rewritten.bytes.includes(Buffer.from("TIT2"))).toBe(true);
    expect(rewritten.bytes.includes(Buffer.from("CHAP"))).toBe(true);
    expect(rewritten.bytes.includes(Buffer.from("CTOC"))).toBe(true);
    expect(rewritten.bytes.includes(Buffer.from("ch0\0"))).toBe(true);
    expect(rewritten.bytes.includes(Buffer.from("Part Two"))).toBe(true);
    const chap = frameSizeBytes(rewritten.bytes, "CHAP", 3);
    expect(chap).not.toBeNull();
    const size = chap!.readUInt32BE(0);
    expect(size).toBeGreaterThan(127);
    expect([...chap!]).toEqual([...beSize(size)]);
    expect([...chap!]).not.toEqual([...syncsafeSize(size)]);
  });

  it("writes syncsafe chapter sizes and a CTOC into an ID3v2.4 tag", () => {
    const file = tag(tit2("History"), 8192, 4);
    const tagLength = file.length - 2;
    const title = `Part Four ${"word ".repeat(40)}`;
    const rewritten = rewriteId3ChapterHeader(file.subarray(0, tagLength), [
      { title, startMs: 0, endMs: 1000 },
      { title: "Part Five", startMs: 1000, endMs: 2000 },
    ]);
    expect(rewritten.ok).toBe(true);
    if (!rewritten.ok) return;
    const chap = frameSizeBytes(rewritten.bytes, "CHAP", 4);
    expect(chap).not.toBeNull();
    const size = unsynchsafe(chap!);
    expect(size).toBeGreaterThan(127);
    expect([...chap!]).toEqual([...syncsafeSize(size)]);
    expect([...chap!]).not.toEqual([...beSize(size)]);
    expect(rewritten.bytes.includes(Buffer.from("CTOC"))).toBe(true);
    expect(rewritten.bytes.includes(Buffer.from("ch0\0"))).toBe(true);
    expect(rewritten.bytes.includes(Buffer.from("ch1\0"))).toBe(true);
  });

  it("refuses a tag that has no room, and a file that has no ID3 header", () => {
    const tight = tag(tit2("History"), 8);
    const refused = rewriteId3ChapterHeader(tight.subarray(0, tight.length - 2), [
      { title: "Part One", startMs: 0, endMs: 5000 },
      { title: "A much longer chapter title that will not fit", startMs: 5000, endMs: 9000 },
    ]);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toMatch(/padding/);
    const bare = rewriteId3ChapterHeader(Buffer.from([0xff, 0xfb, 0x90, 0xc0]), [
      { title: "Part One", startMs: 0, endMs: 1 },
    ]);
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.reason).toMatch(/no ID3v2/);
  });
});
