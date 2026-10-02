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

export function ffmetadataForChapters(chapters: Id3Chapter[]): string {
  const lines = [";FFMETADATA1"];
  let lastEnd = 0;
  for (const chapter of chapters) {
    const start = Math.max(lastEnd, Math.round(chapter.startMs));
    const end = Math.max(start + 1, Math.round(chapter.endMs));
    lastEnd = end;
    lines.push(
      "[CHAPTER]",
      "TIMEBASE=1/1000",
      `START=${start}`,
      `END=${end}`,
      `title=${escapeFfmetadata(chapter.title) || "Chapter"}`
    );
  }
  return lines.join("\n") + "\n";
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
