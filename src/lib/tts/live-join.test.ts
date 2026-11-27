import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { playbackChaptersWithTimes } from "@/lib/player/playback-chapters";
import {
  appendMasteredSection,
  joinMasteredMp3s,
  type LiveJoinCursor,
} from "@/lib/tts/section-master";
import { spawnFfmpeg } from "@/lib/tts/stream-finalize";

async function sine(file: string, frequency: number): Promise<void> {
  await spawnFfmpeg(
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${frequency}:duration=5`,
      "-ac",
      "1",
      "-ar",
      "44100",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      "-write_xing",
      "0",
      file,
    ],
    20_000
  );
}

/** Chapter rows the finalize step writes from the join's own timestamps. */
export function finalizeTiming(input: {
  sectionStarts: number[];
  totalSeconds: number;
  titles: string[];
}): {
  sectionStarts: number[];
  totalSeconds: number;
  durationSeconds: number;
  chapters: Array<{ title: string; startSeconds: number }>;
} {
  const chapters = playbackChaptersWithTimes(
    input.titles.map((title, sectionIndex) => ({ title, sectionIndex })),
    input.sectionStarts,
    input.totalSeconds
  );
  return {
    sectionStarts: input.sectionStarts,
    totalSeconds: input.totalSeconds,
    durationSeconds: Math.round(input.totalSeconds),
    chapters: chapters.map((chapter) => ({
      title: chapter.title,
      startSeconds: chapter.startSeconds ?? 0,
    })),
  };
}

describe("incremental mastered join", () => {
  it("matches a final join's bytes, duration, and chapter times", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "live-join-"));
    try {
      const files = [0, 1, 2].map((index) => path.join(root, `s${index}.mp3`));
      await sine(files[0]!, 220);
      await sine(files[1]!, 330);
      await sine(files[2]!, 440);
      const joins = ["paragraph", "chapter", "paragraph"] as const;
      let audio: Buffer | null = null;
      let cursor: LiveJoinCursor | null = null;
      for (let index = 0; index < files.length; index++) {
        const work = path.join(root, `step${index}`);
        await mkdir(work, { recursive: true });
        const step = await appendMasteredSection({
          joined: audio,
          cursor,
          previousFile: index === 0 ? null : files[index - 1]!,
          nextFile: files[index]!,
          previousJoin: joins[Math.max(0, index - 1)]!,
          nextJoin: joins[index]!,
          crossfadeMs: 120,
          workDir: work,
          run: spawnFfmpeg,
          timeoutMs: 60_000,
        });
        expect("rebuild" in step).toBe(false);
        if ("rebuild" in step) return;
        audio = step.audio;
        cursor = step.cursor;
      }
      const finalDir = path.join(root, "final");
      await mkdir(finalDir, { recursive: true });
      const outPath = path.join(finalDir, "full.mp3");
      const joined = await joinMasteredMp3s({
        files,
        joins: [...joins],
        crossfadeMs: 120,
        outPath,
        workDir: finalDir,
        run: spawnFfmpeg,
        timeoutMs: 90_000,
      });
      const finalBytes = await readFile(outPath);
      expect(audio!.equals(finalBytes)).toBe(true);
      expect(cursor!.totalSeconds).toBeCloseTo(joined.totalSeconds, 2);
      expect(cursor!.sectionStarts).toEqual(joined.sectionStarts);
      const timing = finalizeTiming({
        sectionStarts: cursor!.sectionStarts,
        totalSeconds: cursor!.totalSeconds,
        titles: ["One", "Two"],
      });
      expect(timing.durationSeconds).toBe(Math.round(joined.totalSeconds));
      expect(timing.chapters[0]).toMatchObject({ title: "One", startSeconds: 0 });
      expect(timing.chapters[1]!.startSeconds).toBeCloseTo(joined.sectionStarts[1]!, 2);
      expect(timing.sectionStarts).toEqual(joined.sectionStarts);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
