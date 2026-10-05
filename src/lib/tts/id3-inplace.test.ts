import { describe, expect, it } from "vitest";
import { rewriteId3ChapterHeader } from "./id3-inplace";

function synchsafe(size: number): Buffer {
  const header = Buffer.alloc(10, 0);
  header.write("ID3", 0, "ascii");
  header[3] = 3;
  header[6] = (size >> 21) & 0x7f;
  header[7] = (size >> 14) & 0x7f;
  header[8] = (size >> 7) & 0x7f;
  header[9] = size & 0x7f;
  return header;
}

function tit2(title: string): Buffer {
  const body = Buffer.concat([Buffer.from([0]), Buffer.from(title, "latin1")]);
  const frame = Buffer.alloc(10 + body.length);
  frame.write("TIT2", 0, "ascii");
  frame.writeUInt32BE(body.length, 4);
  body.copy(frame, 10);
  return frame;
}

function tag(body: Buffer, padding: number): Buffer {
  return Buffer.concat([synchsafe(body.length + padding), body, Buffer.alloc(padding, 0), Buffer.from([0xff, 0xfb])]);
}

describe("rewriteId3ChapterHeader", () => {
  it("rewrites chapters inside the existing tag and leaves the audio in place", () => {
    const file = tag(tit2("History"), 4096);
    const tagLength = file.length - 2;
    const rewritten = rewriteId3ChapterHeader(file.subarray(0, tagLength), [
      { title: "Part One", startMs: 0, endMs: 1000 },
      { title: "Part Two", startMs: 1000, endMs: 2500 },
    ]);
    expect(rewritten.ok).toBe(true);
    if (!rewritten.ok) return;
    expect(rewritten.bytes.length).toBe(tagLength);
    expect(rewritten.bytes.includes(Buffer.from("TIT2"))).toBe(true);
    expect(rewritten.bytes.includes(Buffer.from("CHAP"))).toBe(true);
    expect(rewritten.bytes.includes(Buffer.from("Part Two"))).toBe(true);
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
