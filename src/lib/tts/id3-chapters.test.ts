import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ffmetadataForChapters, muxChaptersIntoMp3 } from "./id3-chapters";

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
});
