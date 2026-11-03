import { describe, expect, it } from "vitest";
import { id3v2TotalBytes, unsynchsafeAt } from "./id3-size";

function tag(size: number, flags = 0, total = 4096): Buffer {
  const head = Buffer.alloc(total);
  head.write("ID3", 0, "ascii");
  head[3] = 3;
  head[5] = flags;
  head[6] = (size >> 21) & 0x7f;
  head[7] = (size >> 14) & 0x7f;
  head[8] = (size >> 7) & 0x7f;
  head[9] = size & 0x7f;
  return head;
}

describe("id3v2TotalBytes", () => {
  it("returns 0 when there is no ID3 tag", () => {
    expect(id3v2TotalBytes(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe(0);
    expect(id3v2TotalBytes(Buffer.alloc(4))).toBe(0);
  });

  it("adds the 10-byte header to the synchsafe size", () => {
    expect(id3v2TotalBytes(tag(100))).toBe(110);
  });

  it("adds the 10-byte footer when the flag is set", () => {
    expect(id3v2TotalBytes(tag(100, 0x10))).toBe(120);
  });

  it("clamps to the buffer so a truncated tag never indexes past it", () => {
    expect(id3v2TotalBytes(tag(2000, 0, 50))).toBe(50);
  });

  it("accepts a Uint8Array as well as a Buffer", () => {
    expect(id3v2TotalBytes(new Uint8Array(tag(50)))).toBe(60);
  });
});

describe("unsynchsafeAt", () => {
  it("decodes a frame size at an offset", () => {
    const frame = Buffer.from([0x00, 0x00, 0x02, 0x01]); // 0x101 = 257
    expect(unsynchsafeAt(frame, 0)).toBe(257);
  });
});
