import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildId3ChapterTag,
  ffmetadataForChapters,
  id3v2HeaderBytes,
  muxChaptersIntoMp3,
} from "./id3-chapters";

function synchsafe(size: number): number[] {
  return [
    (size >>> 21) & 0x7f,
    (size >>> 14) & 0x7f,
    (size >>> 7) & 0x7f,
    size & 0x7f,
  ];
}

function frameIds(tag: Buffer): string[] {
  const ids: string[] = [];
  const end = 10 + (((tag[6]! & 0x7f) << 21) | ((tag[7]! & 0x7f) << 14) | ((tag[8]! & 0x7f) << 7) | (tag[9]! & 0x7f));
  let offset = 10;
  while (offset + 10 <= end) {
    const id = tag.toString("ascii", offset, offset + 4);
    const size = tag.readUInt32BE(offset + 4);
    ids.push(id);
    offset += 10 + size;
  }
  expect(offset).toBe(end);
  return ids;
}

describe("buildId3ChapterTag", () => {
  it("writes an ID3v2.3 tag with a synchsafe size and ordered CTOC then CHAP frames", () => {
    const tag = buildId3ChapterTag([
      { title: "Chapter One", startMs: 0, endMs: 65_250 },
      { title: "Chapter Two", startMs: 65_250, endMs: 120_000 },
    ]);
    expect(tag.toString("ascii", 0, 3)).toBe("ID3");
    expect(tag[3]).toBe(3);
    expect(tag[4]).toBe(0);
    const size =
      ((tag[6]! & 0x7f) << 21) |
      ((tag[7]! & 0x7f) << 14) |
      ((tag[8]! & 0x7f) << 7) |
      (tag[9]! & 0x7f);
    expect(size).toBe(tag.length - 10);
    expect(tag.subarray(6, 10)).toEqual(Buffer.from(synchsafe(size)));
    expect(frameIds(tag)).toEqual(["CTOC", "CHAP", "CHAP"]);
    expect(tag.includes(Buffer.from("Chapter One", "utf16le"))).toBe(true);
    // Milliseconds in each CHAP body, matching ffmetadataForChapters.
    const text = ffmetadataForChapters([
      { title: "Chapter One", startMs: 0, endMs: 65_250 },
      { title: "Chapter Two", startMs: 65_250, endMs: 120_000 },
    ]);
    expect(text).toContain("START=65250");
    const firstChap = tag.indexOf("CHAP", 10, "ascii");
    // Frame header, "chp0\0", then START / END in milliseconds.
    expect(tag.readUInt32BE(firstChap + 10 + 5)).toBe(0);
    expect(tag.readUInt32BE(firstChap + 10 + 9)).toBe(65_250);
  });

  it("emits nothing for an empty chapter list", () => {
    expect(buildId3ChapterTag([]).length).toBe(0);
  });
});

describe("id3v2HeaderBytes", () => {
  it("returns 0 for audio without an ID3 tag", () => {
    expect(id3v2HeaderBytes(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe(0);
    expect(id3v2HeaderBytes(Buffer.alloc(0))).toBe(0);
  });

  it("reads the synchsafe size and counts a footer", () => {
    const plain = Buffer.from([...Buffer.from("ID3"), 3, 0, 0, ...synchsafe(1000)]);
    expect(id3v2HeaderBytes(plain)).toBe(1010);
    const footer = Buffer.from([...Buffer.from("ID3"), 4, 0, 0x10, ...synchsafe(20)]);
    expect(id3v2HeaderBytes(footer)).toBe(40);
  });

  it("measures the tag it builds", () => {
    const tag = buildId3ChapterTag([{ title: "One", startMs: 0, endMs: 1000 }]);
    expect(id3v2HeaderBytes(tag)).toBe(tag.length);
  });
});

describe("ffmetadataForChapters", () => {
  it("writes monotonic chapter blocks on a 1/1000 timebase", () => {
    const meta = ffmetadataForChapters([
      { title: "Chapter One", startMs: 0, endMs: 65_250 },
      { title: "Chapter Two", startMs: 65_250, endMs: 120_000 },
    ]);
    expect(meta).toBe(
      [
        ";FFMETADATA1",
        "[CHAPTER]",
        "TIMEBASE=1/1000",
        "START=0",
        "END=65250",
        "title=Chapter One",
        "[CHAPTER]",
        "TIMEBASE=1/1000",
        "START=65250",
        "END=120000",
        "title=Chapter Two",
        "",
      ].join("\n")
    );
  });

  it("escapes ffmetadata separators and keeps chapters monotonic", () => {
    const meta = ffmetadataForChapters([
      { title: "Book One; Chapter #1 = \"Home\"", startMs: 5000, endMs: 4000 },
      { title: "Next\nLine", startMs: 2000, endMs: 9000 },
    ]);
    expect(meta).toContain("title=Book One\\; Chapter \\#1 \\= \"Home\"");
    expect(meta).toContain("title=Next Line");
    const starts = [...meta.matchAll(/^START=(\d+)$/gm)].map((m) => Number(m[1]));
    const ends = [...meta.matchAll(/^END=(\d+)$/gm)].map((m) => Number(m[1]));
    expect(starts).toEqual([5000, 5001]);
    expect(ends).toEqual([5001, 9000]);
  });
});

const hasFfmpeg =
  spawnSync("ffmpeg", ["-version"]).status === 0 &&
  spawnSync("ffprobe", ["-version"]).status === 0;

describe.skipIf(!hasFfmpeg)("muxChaptersIntoMp3", () => {
  it("adds ID3 CHAP frames a player can read back", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ec-chap-"));
    try {
      const src = path.join(dir, "src.mp3");
      const dest = path.join(dir, "out.mp3");
      const make = spawnSync("ffmpeg", [
        "-hide_banner",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=4",
        "-codec:a",
        "libmp3lame",
        "-q:a",
        "4",
        src,
      ]);
      if (make.status !== 0) throw new Error("ffmpeg source render failed");

      const run = async (args: string[]) => {
        const result = spawnSync("ffmpeg", ["-hide_banner", ...args], {
          encoding: "utf8",
        });
        if (result.status !== 0) throw new Error(result.stderr.slice(-400));
      };
      await muxChaptersIntoMp3({
        run,
        srcPath: src,
        destPath: dest,
        workDir: dir,
        chapters: [
          { title: "Chapter One", startMs: 0, endMs: 2000 },
          { title: "Book Two · Chapter II", startMs: 2000, endMs: 4000 },
        ],
      });

      const probe = spawnSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "chapter=start_time,end_time:chapter_tags=title",
          "-of",
          "json",
          dest,
        ],
        { encoding: "utf8" }
      );
      const parsed = JSON.parse(probe.stdout) as {
        chapters?: { start_time: string; end_time: string; tags?: { title?: string } }[];
      };
      expect(
        parsed.chapters?.map((chapter) => ({
          title: chapter.tags?.title,
          start: Number(chapter.start_time),
          end: Number(chapter.end_time),
        }))
      ).toEqual([
        { title: "Chapter One", start: 0, end: 2 },
        { title: "Book Two · Chapter II", start: 2, end: 4 },
      ]);

      // The audio itself is a packet copy: same bytes length class, no re-encode.
      const srcBytes = await readFile(src);
      const destBytes = await readFile(dest);
      expect(Math.abs(destBytes.length - srcBytes.length)).toBeLessThan(8192);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("prepends the built tag to an existing MP3 and ffprobe reads it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ec-chap-prefix-"));
    try {
      const src = path.join(dir, "src.mp3");
      const dest = path.join(dir, "out.mp3");
      const make = spawnSync("ffmpeg", [
        "-hide_banner",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=4",
        "-codec:a",
        "libmp3lame",
        "-q:a",
        "4",
        src,
      ]);
      if (make.status !== 0) throw new Error("ffmpeg source render failed");

      const tag = buildId3ChapterTag([
        { title: "Chapter One", startMs: 0, endMs: 2000 },
        { title: "Book Two · Chapter II", startMs: 2000, endMs: 4000 },
      ]);
      const srcBytes = await readFile(src);
      const skip = id3v2HeaderBytes(srcBytes);
      await writeFile(dest, Buffer.concat([tag, srcBytes.subarray(skip)]));

      const probe = spawnSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "chapter=start_time,end_time:chapter_tags=title",
          "-of",
          "json",
          dest,
        ],
        { encoding: "utf8" }
      );
      const parsed = JSON.parse(probe.stdout) as {
        chapters?: { start_time: string; end_time: string; tags?: { title?: string } }[];
      };
      expect(
        parsed.chapters?.map((chapter) => ({
          title: chapter.tags?.title,
          start: Number(chapter.start_time),
          end: Number(chapter.end_time),
        }))
      ).toEqual([
        { title: "Chapter One", start: 0, end: 2 },
        { title: "Book Two · Chapter II", start: 2, end: 4 },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
