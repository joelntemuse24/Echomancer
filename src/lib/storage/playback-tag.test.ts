import { describe, expect, it } from "vitest";
import { buildId3ChapterTag } from "@/lib/tts/id3-chapters";
import {
  MAX_PLAYBACK_TAG_BYTES,
  fileSizeFromProbeRange,
  playbackTagLength,
  shiftClientRange,
} from "./playback-tag";

function taggedBook(): { file: Buffer; tagBytes: number } {
  const tag = buildId3ChapterTag([{ title: "Chapter", startMs: 0, endMs: 1000 }]);
  const audio = Buffer.concat([
    Buffer.from([0xff, 0xfb, 0x90, 0xc4]),
    Buffer.alloc(200, 0x11),
  ]);
  return { file: Buffer.concat([tag, audio]), tagBytes: tag.length };
}

describe("playbackTagLength", () => {
  it("is zero when the object does not start with ID3", () => {
    expect(playbackTagLength(new Uint8Array([0xff, 0xfb, 0x90, 0xc4]), 400)).toBe(0);
  });

  it("is the whole tag when only the 10-byte header is in hand", () => {
    const { file, tagBytes } = taggedBook();
    expect(playbackTagLength(file.subarray(0, 10), file.length)).toBe(tagBytes);
    expect(file.subarray(tagBytes, tagBytes + 4)).toEqual(
      Buffer.from([0xff, 0xfb, 0x90, 0xc4])
    );
  });

  it("does not hide a tag that claims the rest of the file or more than the cap", () => {
    const header = new Uint8Array(10);
    header.set(Buffer.from("ID3"));
    header[3] = 3;
    header[9] = 100;
    expect(playbackTagLength(header, 50)).toBe(0);
    // Payload of exactly the cap: the tag itself is larger than the cap.
    header[6] = 0;
    header[7] = (MAX_PLAYBACK_TAG_BYTES >> 14) & 0x7f;
    header[8] = (MAX_PLAYBACK_TAG_BYTES >> 7) & 0x7f;
    header[9] = MAX_PLAYBACK_TAG_BYTES & 0x7f;
    expect(playbackTagLength(header, MAX_PLAYBACK_TAG_BYTES + 100)).toBe(0);
  });
});

describe("shiftClientRange", () => {
  const tag = { fileSize: 575_515_806, tagBytes: 1893 };

  it("serves the first audio bytes when the client asks for the start", () => {
    expect(shiftClientRange("bytes=0-15", tag)).toEqual({
      fileRange: "bytes=1893-1908",
      contentRange: `bytes 0-15/${575_515_806 - 1893}`,
      contentLength: 16,
    });
  });

  it("keeps a later window and a tail probe in the audio coordinate space", () => {
    expect(shiftClientRange("bytes=262144-262147", tag)).toMatchObject({
      fileRange: "bytes=264037-264040",
      contentRange: `bytes 262144-262147/${575_515_806 - 1893}`,
    });
    const tail = shiftClientRange("bytes=-32", tag);
    const audioSize = 575_515_806 - 1893;
    expect(tail).toMatchObject({
      fileRange: `bytes=${575_515_806 - 32}-${575_515_806 - 1}`,
      contentRange: `bytes ${audioSize - 32}-${audioSize - 1}/${audioSize}`,
      contentLength: 32,
    });
  });

  it("rejects a range that starts past the audio", () => {
    expect(shiftClientRange("bytes=575515000-575515004", tag)).toBe("unsatisfiable");
  });
});

describe("fileSizeFromProbeRange", () => {
  it("reads the total only from a probe that starts at byte 0", () => {
    expect(fileSizeFromProbeRange("bytes 0-9/575515806")).toBe(575515806);
    expect(fileSizeFromProbeRange("bytes 1893-1902/575515806")).toBeNull();
    expect(fileSizeFromProbeRange(undefined)).toBeNull();
  });
});
