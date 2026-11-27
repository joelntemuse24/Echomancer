import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  downloadFile,
  downloadFileToPath,
  fileExists,
  uploadFile,
  uploadFileFromPath,
} from "@/lib/storage";
import { jobScratchDir } from "@/lib/tts/job-scratch";
import { muxChaptersIntoMp3, type Id3Chapter } from "@/lib/tts/id3-chapters";
import { loadFrozenSectionOutline, PLAYBACK_CHAPTERS_NAME } from "@/lib/tts/frozen-script";
import {
  chapterSpansFromSections,
  playbackChaptersWithTimes,
  type PlaybackChapter,
} from "@/lib/player/playback-chapters";
import {
  appendMasteredSection,
  joinMasteredMp3s,
  type LiveJoinCursor,
} from "@/lib/tts/section-master";
import { spawnFfmpeg } from "@/lib/tts/stream-finalize";
import { resolveConcatCrossfadeMs } from "@/lib/tts/crossfade-audio";
import type { JobSegment, SectionJoinKind } from "@/lib/tts/types";

const STATE_FILE = "live-join.json";

export type LiveJoinState = LiveJoinCursor & {
  joined: number;
  /** False when a short section was folded and the next extend must rejoin. */
  stable: boolean;
};

export type LiveJoinResult = {
  path: string;
  joined: number;
  totalSeconds: number;
  sectionStarts: number[];
  durationSeconds: number;
  chapters: PlaybackChapter[];
};

const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(jobId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  queues.set(
    jobId,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

function masteredPrefix(segments: JobSegment[]): JobSegment[] {
  const byIndex = new Map(segments.map((segment) => [segment.index, segment]));
  const prefix: JobSegment[] = [];
  for (let index = 0; ; index++) {
    const segment = byIndex.get(index);
    if (!segment || segment.status !== "ready" || segment.mastered !== true) break;
    if (!segment.path.endsWith(".mp3")) break;
    prefix.push(segment);
  }
  return prefix;
}

function statePath(jobId: string): string {
  return path.join(jobScratchDir(jobId), STATE_FILE);
}

function audioPath(jobId: string): string {
  return path.join(jobScratchDir(jobId), "live.mp3");
}

async function readState(jobId: string): Promise<LiveJoinState | null> {
  try {
    const raw = await readFile(statePath(jobId), "utf8");
    const parsed = JSON.parse(raw) as LiveJoinState;
    if (!parsed || !Number.isInteger(parsed.joined) || !Array.isArray(parsed.sectionStarts)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeState(jobId: string, state: LiveJoinState): Promise<void> {
  await mkdir(jobScratchDir(jobId), { recursive: true });
  await writeFile(statePath(jobId), JSON.stringify(state));
}

async function sectionFile(jobId: string, segment: JobSegment): Promise<string> {
  const dest = path.join(jobScratchDir(jobId), `sec-${String(segment.index).padStart(4, "0")}.mp3`);
  try {
    await readFile(dest);
    return dest;
  } catch {
    await mkdir(path.dirname(dest), { recursive: true });
    await downloadFileToPath(segment.path, dest);
    return dest;
  }
}

function cursorFromParts(
  joined: Awaited<ReturnType<typeof joinMasteredMp3s>>,
  audioLength: number
): LiveJoinCursor & { stable: boolean } {
  if (joined.absorbed > 0 || joined.parts.length === 0) {
    return {
      sectionStarts: joined.sectionStarts,
      totalSeconds: joined.totalSeconds,
      lastBodyByte: audioLength,
      lastHeadSeconds: 0,
      stable: false,
    };
  }
  let lastBodyByte = 0;
  let bodies = 0;
  const bodyCount = joined.parts.filter((part) => part.kind === "body").length;
  for (const part of joined.parts) {
    if (part.kind === "body") {
      bodies += 1;
      if (bodies === bodyCount) break;
    }
    lastBodyByte += part.bytes.length;
  }
  return {
    sectionStarts: joined.sectionStarts,
    totalSeconds: joined.totalSeconds,
    lastBodyByte,
    lastHeadSeconds: joined.headSeconds[joined.headSeconds.length - 1] ?? 0,
    stable: true,
  };
}

async function rejoinPrefix(
  jobId: string,
  files: string[],
  joins: SectionJoinKind[],
  crossfadeMs: number
): Promise<{ audio: Buffer; cursor: LiveJoinCursor; stable: boolean }> {
  const work = path.join(jobScratchDir(jobId), `rejoin-${files.length}`);
  await mkdir(work, { recursive: true });
  const outPath = path.join(work, "full.mp3");
  const joined = await joinMasteredMp3s({
    files,
    joins,
    crossfadeMs,
    outPath,
    workDir: work,
    run: spawnFfmpeg,
    timeoutMs: 120_000,
  });
  const audio = await readFile(outPath);
  const cursor = cursorFromParts(joined, audio.length);
  return { audio, cursor, stable: cursor.stable };
}

/**
 * Append every newly contiguous mastered section onto `full.mp3`.
 * Sections behind a hole stay out of the file until the hole is filled.
 */
export async function extendLiveJoin(opts: {
  jobId: string;
  segments: JobSegment[];
  joinKinds: Array<SectionJoinKind | undefined>;
  crossfadeMs?: number;
}): Promise<LiveJoinResult | null> {
  return enqueue(opts.jobId, async () => {
    const prefix = masteredPrefix(opts.segments);
    if (prefix.length === 0) return null;
    const crossfadeMs = opts.crossfadeMs ?? resolveConcatCrossfadeMs();
    await mkdir(jobScratchDir(opts.jobId), { recursive: true });
    let state = await readState(opts.jobId);
    if (state && state.joined > prefix.length) state = null;
    if (state && state.joined === prefix.length) {
      return publishShape(opts.jobId, state);
    }
    const joins = prefix.map((segment, index) => opts.joinKinds[segment.index] ?? (index === 0 ? "chapter" : "paragraph"));
    let audio: Buffer | null = null;
    if (state && state.joined > 0 && state.stable) {
      try {
        audio = await readFile(audioPath(opts.jobId));
      } catch {
        if (await fileExists(`audiobooks/${opts.jobId}/full.mp3`)) {
          audio = await downloadFile(`audiobooks/${opts.jobId}/full.mp3`);
        } else {
          state = null;
          audio = null;
        }
      }
    }
    const start = state && audio ? state.joined : 0;
    if (start === 0) state = null;
    for (let index = start; index < prefix.length; index++) {
      const segment = prefix[index]!;
      const nextFile = await sectionFile(opts.jobId, segment);
      const work = path.join(jobScratchDir(opts.jobId), `append-${index}`);
      await mkdir(work, { recursive: true });
      if (!state || !audio) {
        const step = await appendMasteredSection({
          joined: null,
          cursor: null,
          previousFile: null,
          nextFile,
          previousJoin: joins[index]!,
          nextJoin: joins[index]!,
          crossfadeMs,
          workDir: work,
          run: spawnFfmpeg,
          timeoutMs: 120_000,
        });
        if ("rebuild" in step) return null;
        audio = step.audio;
        state = { ...step.cursor, joined: index + 1, stable: true };
        continue;
      }
      if (!state.stable) {
        const files: string[] = [];
        for (const item of prefix.slice(0, index + 1)) files.push(await sectionFile(opts.jobId, item));
        const rebuilt = await rejoinPrefix(opts.jobId, files, joins.slice(0, index + 1), crossfadeMs);
        audio = rebuilt.audio;
        state = { ...rebuilt.cursor, joined: index + 1, stable: rebuilt.stable };
        continue;
      }
      const previous = prefix[index - 1]!;
      const step = await appendMasteredSection({
        joined: audio,
        cursor: state,
        previousFile: await sectionFile(opts.jobId, previous),
        nextFile,
        previousJoin: joins[index - 1]!,
        nextJoin: joins[index]!,
        crossfadeMs,
        workDir: work,
        run: spawnFfmpeg,
        timeoutMs: 120_000,
      });
      if ("rebuild" in step) {
        const files: string[] = [];
        for (const item of prefix.slice(0, index + 1)) files.push(await sectionFile(opts.jobId, item));
        const rebuilt = await rejoinPrefix(opts.jobId, files, joins.slice(0, index + 1), crossfadeMs);
        audio = rebuilt.audio;
        state = { ...rebuilt.cursor, joined: index + 1, stable: rebuilt.stable };
        continue;
      }
      audio = step.audio;
      state = { ...step.cursor, joined: index + 1, stable: true };
    }
    if (!state || !audio) return null;
    await writeFile(audioPath(opts.jobId), audio);
    await writeState(opts.jobId, state);
    const uploaded = await uploadFileFromPath(
      `audiobooks/${opts.jobId}`,
      "full.mp3",
      audioPath(opts.jobId),
      "audio/mpeg"
    );
    await uploadFile(
      `audiobooks/${opts.jobId}`,
      STATE_FILE,
      Buffer.from(JSON.stringify(state)),
      "application/json"
    );
    const shape = publishShape(opts.jobId, state);
    return { ...shape, path: uploaded.path };
  });
}

function publishShape(jobId: string, state: LiveJoinState): LiveJoinResult {
  return {
    path: `audiobooks/${jobId}/full.mp3`,
    joined: state.joined,
    totalSeconds: state.totalSeconds,
    sectionStarts: state.sectionStarts,
    durationSeconds: Math.round(state.totalSeconds),
    chapters: [],
  };
}

/**
 * ID3 chapters, duration, and section timing from the join that was already
 * written. Returns null when the rolling file does not cover every section,
 * so the caller keeps the full materialize path.
 */
export async function finalizeLiveJoin(opts: {
  jobId: string;
  total: number;
}): Promise<LiveJoinResult | null> {
  const state = await readState(opts.jobId);
  if (!state || state.joined < opts.total || opts.total <= 0) return null;
  let chapters: PlaybackChapter[] = [];
  try {
    const outline = await loadFrozenSectionOutline(opts.jobId);
    const spans = outline ? chapterSpansFromSections(outline) : [];
    chapters = playbackChaptersWithTimes(spans, state.sectionStarts, state.totalSeconds);
    if (chapters.length > 0) {
      const id3: Id3Chapter[] = chapters.map((chapter) => ({
        title: chapter.title,
        startMs: Math.round((chapter.startSeconds ?? 0) * 1000),
        endMs: Math.round((chapter.endSeconds ?? state.totalSeconds) * 1000),
      }));
      const scratch = jobScratchDir(opts.jobId);
      const src = audioPath(opts.jobId);
      const dest = path.join(scratch, "full-chapters.mp3");
      await muxChaptersIntoMp3({
        run: spawnFfmpeg,
        srcPath: src,
        destPath: dest,
        workDir: scratch,
        chapters: id3,
        timeoutMs: 60_000,
      });
      await uploadFileFromPath(`audiobooks/${opts.jobId}`, "full.mp3", dest, "audio/mpeg");
    }
  } catch (err) {
    console.warn(
      `[Job ${opts.jobId}] live-join chapter tag skipped:`,
      err instanceof Error ? err.message : err
    );
  }
  const body = Buffer.from(
    JSON.stringify({
      chapters,
      sectionStarts: state.sectionStarts,
      totalSeconds: state.totalSeconds,
    })
  );
  await uploadFile(`audiobooks/${opts.jobId}`, PLAYBACK_CHAPTERS_NAME, body, "application/json");
  await uploadFile(
    `audiobooks/${opts.jobId}`,
    "section-starts.json",
    Buffer.from(
      JSON.stringify({
        sectionStarts: state.sectionStarts,
        totalSeconds: state.totalSeconds,
      })
    ),
    "application/json"
  );
  return {
    path: `audiobooks/${opts.jobId}/full.mp3`,
    joined: state.joined,
    totalSeconds: state.totalSeconds,
    sectionStarts: state.sectionStarts,
    durationSeconds: Math.round(state.totalSeconds),
    chapters,
  };
}
