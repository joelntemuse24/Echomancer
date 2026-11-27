import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { playbackChaptersWithTimes } from "@/lib/player/playback-chapters";
import {
  appendMasteredSection,
  indexMp3Packets,
  joinMasteredMp3s,
  mp3IndexedDuration,
  publishedPrefix,
  type LiveJoinCursor,
} from "@/lib/tts/section-master";
import { cursorAfterFold, extendLiveJoin, finalizeLiveJoin, foldSectionStarts, repairPublishedPlaylist } from "@/lib/tts/live-join";
import { jobScratchDir, removeJobScratch } from "@/lib/tts/job-scratch";
import { downloadFile, uploadFile } from "@/lib/storage";
import { spawnFfmpeg } from "@/lib/tts/stream-finalize";
import type { JobSegment } from "@/lib/tts/types";

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
      "-id3v2_version",
      "0",
      "-write_id3v1",
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
      let published: Buffer | null = null;
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
        if (published && published.length > 0) {
          expect(step.audio.subarray(0, published.length).equals(published)).toBe(true);
        }
        audio = step.audio;
        cursor = step.cursor;
        published = await publishedPrefix(step.audio);
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
      if (published && published.length > 0) {
        expect(finalBytes.subarray(0, published.length).equals(published)).toBe(true);
      }
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

  it("keeps the published prefix when a short section is folded forward", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "live-join-short-"));
    try {
      const longA = path.join(root, "a.mp3");
      const short = path.join(root, "b.mp3");
      const longB = path.join(root, "c.mp3");
      await sine(longA, 220);
      await spawnFfmpeg(
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=330:duration=1",
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
          short,
        ],
        20_000
      );
      await sine(longB, 440);
      const firstDir = path.join(root, "first");
      await mkdir(firstDir, { recursive: true });
      const first = await appendMasteredSection({
        joined: null,
        cursor: null,
        previousFile: null,
        nextFile: longA,
        previousJoin: "paragraph",
        nextJoin: "paragraph",
        crossfadeMs: 120,
        workDir: firstDir,
        run: spawnFfmpeg,
        timeoutMs: 60_000,
      });
      if ("rebuild" in first) throw new Error("opening section rebuilt");
      const published = await publishedPrefix(first.audio);
      expect(published.length).toBeGreaterThan(0);
      const folded = path.join(root, "folded.mp3");
      const list = path.join(root, "list.txt");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(list, `file '${short}'\nfile '${longB}'\n`);
      await spawnFfmpeg(
        ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-write_xing", "0", folded],
        20_000
      );
      const secondDir = path.join(root, "second");
      await mkdir(secondDir, { recursive: true });
      const second = await appendMasteredSection({
        joined: first.audio,
        cursor: first.cursor,
        previousFile: longA,
        nextFile: folded,
        previousJoin: "paragraph",
        nextJoin: "paragraph",
        crossfadeMs: 120,
        workDir: secondDir,
        run: spawnFfmpeg,
        timeoutMs: 60_000,
      });
      expect("rebuild" in second).toBe(false);
      if ("rebuild" in second) return;
      expect(second.audio.subarray(0, published.length).equals(published)).toBe(true);
      const shortDur = mp3IndexedDuration(await indexMp3Packets(await readFile(short)));
      const longDur = mp3IndexedDuration(await indexMp3Packets(await readFile(longB)));
      const expanded = cursorAfterFold(second.cursor.sectionStarts, [shortDur, longDur]);
      expect(expanded).toHaveLength(3);
      expect(expanded[0]).toBe(0);
      expect(expanded[2]! - expanded[1]!).toBeCloseTo(shortDur, 1);
      expect(new Set(expanded.map((start) => start.toFixed(3))).size).toBe(3);
      expect(foldSectionStarts(expanded[1]!, [shortDur, longDur])[1]).toBeCloseTo(expanded[2]!, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);

  it("rolls several sections, including one folded forward, into a file that covers the book", async () => {
    const jobId = "live-fold-cover";
    const root = await mkdtemp(path.join(tmpdir(), "live-fold-"));
    try {
      const lengths = [6, 6, 1.2, 6];
      const segments: JobSegment[] = [];
      for (let index = 0; index < lengths.length; index++) {
        const file = path.join(root, `s${index}.mp3`);
        await spawnFfmpeg(
          [
            "-y",
            "-f",
            "lavfi",
            "-i",
            `sine=frequency=${220 + index * 110}:duration=${lengths[index]}`,
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
            "-id3v2_version",
            "0",
            "-write_id3v1",
            "0",
            file,
          ],
          20_000
        );
        const name = `${String(index).padStart(4, "0")}.mp3`;
        const storagePath = `audiobooks/${jobId}/sections/${name}`;
        await uploadFile(`audiobooks/${jobId}/sections`, name, await readFile(file), "audio/mpeg");
        segments.push({ index, path: storagePath, status: "ready", mastered: true });
      }
      const joins = ["chapter", "paragraph", "paragraph", "paragraph"] as const;
      for (let count = 1; count <= segments.length; count++) {
        await extendLiveJoin({
          jobId,
          segments: segments.slice(0, count),
          joinKinds: joins.slice(0, count),
          crossfadeMs: 120,
          flush: count === segments.length,
        });
      }
      await stat(path.join(jobScratchDir(jobId), "fold-1", "body_0.mp3"));
      const covered = await finalizeLiveJoin({ jobId, total: segments.length });
      expect(covered).not.toBeNull();
      expect(covered!.joined).toBe(segments.length);
      const full = await downloadFile(`audiobooks/${jobId}/full.mp3`);
      const duration = mp3IndexedDuration(await indexMp3Packets(full));
      const first = mp3IndexedDuration(await indexMp3Packets(await readFile(path.join(root, "s0.mp3"))));
      expect(duration).toBeGreaterThan(first + 10);
      expect(duration).toBeGreaterThan(lengths.reduce((sum, value) => sum + value, 0) - 2);
    } finally {
      await removeJobScratch(jobId).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);

  it("repairs a playlist that lags full.mp3 before writing ENDLIST", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "live-repair-"));
    try {
      const firstFile = path.join(root, "a.mp3");
      const secondFile = path.join(root, "b.mp3");
      await sine(firstFile, 220);
      await sine(secondFile, 440);
      const first = await readFile(firstFile);
      const second = await readFile(secondFile);
      const full = Buffer.concat([first, second]);
      const { uploadFile, downloadFile } = await import("@/lib/storage");
      const { hlsEventPlaylist, readHlsPlaylist } = await import("@/lib/player/live-playlist");
      const jobId = "live-repair-lag";
      await uploadFile(`audiobooks/${jobId}/live`, "0000.mp3", first, "audio/mpeg");
      await uploadFile(
        `audiobooks/${jobId}`,
        "live.m3u8",
        Buffer.from(
          hlsEventPlaylist([{ uri: "live/0000.mp3", seconds: 5 }], first.length, false)
        ),
        "application/vnd.apple.mpegurl"
      );
      await repairPublishedPlaylist(jobId, full, new AbortController().signal, true);
      const playlist = readHlsPlaylist(
        (await downloadFile(`audiobooks/${jobId}/live.m3u8`)).toString("utf8")
      );
      expect(playlist.complete).toBe(true);
      expect(playlist.bytes).toBe(full.length);
      expect(playlist.segments.map((segment) => segment.uri)).toEqual([
        "live/0000.mp3",
        "live/0001.mp3",
      ]);
      expect((await downloadFile(`audiobooks/${jobId}/live/0000.mp3`)).equals(first)).toBe(true);
      expect((await downloadFile(`audiobooks/${jobId}/live/0001.mp3`)).equals(second)).toBe(true);

      const missingId = "live-repair-missing";
      await uploadFile(`audiobooks/${missingId}`, "full.mp3", first, "audio/mpeg");
      await repairPublishedPlaylist(missingId, first, new AbortController().signal, true);
      const created = readHlsPlaylist(
        (await downloadFile(`audiobooks/${missingId}/live.m3u8`)).toString("utf8")
      );
      expect(created.complete).toBe(true);
      expect(created.bytes).toBe(first.length);
      expect(created.segments.map((segment) => segment.uri)).toEqual(["live/0000.mp3"]);
      expect((await downloadFile(`audiobooks/${missingId}/live/0000.mp3`)).equals(first)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
