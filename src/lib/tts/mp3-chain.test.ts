import { describe, expect, it } from "vitest";
import { indexMp3Packets, mp3ChainStart } from "@/lib/tts/section-master";

/** MPEG frame header plus `length` bytes, matching `mp3FrameLength`. */
function frame(header: Buffer, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  header.copy(bytes);
  return bytes;
}

describe("mp3 frame chain", () => {
  it("ignores a two-header coincidence before the real stream", async () => {
    // MPEG-2 Layer III, 32 kbps, 22050 Hz: 104-byte frames. Two of them
    // look like a stream to a scanner that only checks the next header.
    const decoyHeader = Buffer.from([0xff, 0xf3, 0x40, 0xc0]);
    const decoy = Buffer.concat([frame(decoyHeader, 104), frame(decoyHeader, 104)]);
    // MPEG-1 Layer III, 128 kbps, 44100 Hz: 417-byte frames.
    const realHeader = Buffer.from([0xff, 0xfb, 0x90, 0xc0]);
    const real = Buffer.concat(Array.from({ length: 8 }, () => frame(realHeader, 417)));
    const audio = Buffer.concat([decoy, Buffer.alloc(8), real]);
    const realAt = decoy.length + 8;

    expect(mp3ChainStart(audio, 2)).toBe(0);
    expect(mp3ChainStart(audio, 4)).toBe(realAt);

    const packets = await indexMp3Packets(audio);
    expect(packets[0]!.pos).toBe(realAt);
    expect(packets[1]!.pos).toBe(realAt + 417);
    // The old cut, `secondFrameOffset` on the first two-header pair, sat
    // inside the decoy. A mix sliced there is not a decodable MP3.
    expect(packets[1]!.pos).not.toBe(104);
  });
});
