import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { downloadFile, downloadFileToPath, fileExists, uploadFile } from "@/lib/storage";
import { jobScratchDir } from "@/lib/tts/job-scratch";
import { muxChaptersIntoMp3, type Id3Chapter } from "@/lib/tts/id3-chapters";
import { loadFrozenSectionOutline, PLAYBACK_CHAPTERS_NAME } from "@/lib/tts/frozen-script";
import {
  chapterSpansFromSections,
  playbackChaptersWithTimes,
  type PlaybackChapter,
} from "@/lib/player/playback-chapters";
import { hlsEventPlaylist, readHlsPlaylist, type LiveSegment } from "@/lib/player/live-playlist";
import {
  commitLiveUpload,
  reconcilePublished,
  remoteIsFinishedBook,
} from "@/lib/tts/live-publish";
import {
  appendMasteredSection,
  COPY_JOIN_MIN_SECONDS,
  indexMp3Packets,
  joinMasteredMp3s,
  mp3IndexedDuration,
  publishedPrefix,
  STABLE_HOLD_SECONDS,
  type LiveJoinCursor,
} from "@/lib/tts/section-master";
import { spawnFfmpeg } from "@/lib/tts/stream-finalize";
import { resolveConcatCrossfadeMs } from "@/lib/tts/crossfade-audio";
import type { JobSegment, SectionJoinKind } from "@/lib/tts/types";

const STATE_FILE = "live-join.json";
const PLAYLIST_FILE = "live.m3u8";

export type LiveJoinState = LiveJoinCursor & {
  joined: number;
  publishedBytes: number;
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

type Memory = {
  audio: Buffer;
  cursor: LiveJoinCursor;
  joined: number;
  lastPiece: string;
  crossfadeMs: number;
};

const queues = new Map<string, Promise<unknown>>();
const memory = new Map<string, Memory>();

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

/** Wait for this book's rolling upload before the lease is released. */
export async function awaitLiveJoin(jobId: string): Promise<void> {
  const pending = queues.get(jobId);
  if (!pending) return;
  await pending.catch(() => undefined);
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

function audioPath(jobId: string): string {
  return path.join(jobScratchDir(jobId), "live.mp3");
}

async function readState(jobId: string): Promise<LiveJoinState | null> {
  try {
    const raw = await readFile(path.join(jobScratchDir(jobId), STATE_FILE), "utf8");
    const parsed = JSON.parse(raw) as LiveJoinState;
    if (!parsed || !Number.isInteger(parsed.joined) || !Array.isArray(parsed.sectionStarts)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
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

async function remoteFull(jobId: string): Promise<Buffer> {
  const key = `audiobooks/${jobId}/full.mp3`;
  if (!(await fileExists(key))) return Buffer.alloc(0);
  return downloadFile(key);
}

async function forwardFold(files: string[], workDir: string): Promise<string> {
  await mkdir(workDir, { recursive: true });
  const list = path.join(workDir, "list.txt");
  await writeFile(list, files.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join("\n"));
  const out = path.join(workDir, "folded.mp3");
  await spawnFfmpeg(
    ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-write_xing", "0", out],
    60_000
  );
  return out;
}

async function reencodeTail(held: Buffer, files: string[], workDir: string): Promise<Buffer> {
  await mkdir(workDir, { recursive: true });
  const heldPath = path.join(workDir, "held.mp3");
  await writeFile(heldPath, held);
  const folded = await forwardFold([heldPath, ...files], workDir);
  const out = path.join(workDir, "tail.mp3");
  await spawnFfmpeg(
    ["-y", "-i", folded, "-c:a", "libmp3lame", "-b:a", "128k", "-write_xing", "0", out],
    60_000
  );
  return readFile(out);
}

/**
 * Append newly contiguous mastered sections. Short sections are held and
 * folded into the next piece, so bytes already published stay a prefix.
 */
export async function extendLiveJoin(opts: {
  jobId: string;
  segments: JobSegment[];
  joinKinds: Array<SectionJoinKind | undefined>;
  crossfadeMs?: number;
  flush?: boolean;
  holdsLease?: () => Promise<boolean>;
}): Promise<LiveJoinResult | null> {
  return enqueue(opts.jobId, () => extendBody(opts));
}

async function extendBody(opts: {
  jobId: string;
  segments: JobSegment[];
  joinKinds: Array<SectionJoinKind | undefined>;
  crossfadeMs?: number;
  flush?: boolean;
  holdsLease?: () => Promise<boolean>;
}): Promise<LiveJoinResult | null> {
  const prefix = masteredPrefix(opts.segments);
  if (prefix.length === 0) return null;
  const crossfadeMs = opts.crossfadeMs ?? resolveConcatCrossfadeMs();
  const remote = await remoteFull(opts.jobId);
  if (remoteIsFinishedBook(remote)) return null;
  const joins = prefix.map(
    (segment, index) => opts.joinKinds[segment.index] ?? (index === 0 ? "chapter" : "paragraph")
  );
  const built = await joinPrefix(opts.jobId, prefix, joins, crossfadeMs, opts.flush === true);
  if (!built) return null;
  const published = await publishedPrefix(built.audio, opts.flush ? 0 : STABLE_HOLD_SECONDS);
  if (published.length === 0) {
    memory.set(opts.jobId, { ...built, crossfadeMs });
    return null;
  }
  const delta = reconcilePublished(remote, published);
  if (delta == null) {
    console.warn(`[Job ${opts.jobId}] live join refused: stored audio is not a prefix`);
    memory.delete(opts.jobId);
    return null;
  }
  const packets = await indexMp3Packets(published);
  const publishedSeconds = mp3IndexedDuration(packets);
  const state: LiveJoinState = {
    ...built.cursor,
    joined: built.joined,
    publishedBytes: published.length,
    stable: true,
    totalSeconds: built.cursor.totalSeconds,
  };
  if (delta.length > 0 || opts.flush) {
    const heldBefore = opts.holdsLease ? await opts.holdsLease() : true;
    if (!heldBefore) throw leaseLost();
    const abort = new AbortController();
    const timer = setInterval(() => {
      void opts.holdsLease?.().then((ok) => {
        if (!ok) abort.abort();
      }).catch(() => abort.abort());
    }, 400);
    let aborted = false;
    try {
      if (delta.length > 0) {
        await uploadFile(
          `audiobooks/${opts.jobId}`,
          "full.mp3",
          published,
          "audio/mpeg",
          { abortSignal: abort.signal }
        );
        await publishSegment(opts.jobId, remote, delta, abort.signal);
      }
      if (opts.flush) await writePlaylistEnd(opts.jobId, abort.signal);
    } catch (err) {
      aborted = abort.signal.aborted || (err instanceof Error && err.name === "AbortError");
      if (aborted) throw leaseLost();
      throw err;
    } finally {
      clearInterval(timer);
    }
    const heldAfter = opts.holdsLease ? await opts.holdsLease() : true;
    if (!commitLiveUpload({ heldBefore, aborted, heldAfter })) throw leaseLost();
  }
  await mkdir(jobScratchDir(opts.jobId), { recursive: true });
  await writeFile(audioPath(opts.jobId), built.audio);
  await writeFile(
    path.join(jobScratchDir(opts.jobId), STATE_FILE),
    JSON.stringify(state)
  );
  memory.set(opts.jobId, { ...built, crossfadeMs });
  return {
    path: `audiobooks/${opts.jobId}/full.mp3`,
    joined: state.joined,
    totalSeconds: state.totalSeconds,
    sectionStarts: state.sectionStarts,
    durationSeconds: Math.round(publishedSeconds),
    chapters: [],
  };
}

function leaseLost(): Error {
  const err = new Error("live join lost the lease");
  err.name = "LeaseLostError";
  return err;
}

async function publishSegment(
  jobId: string,
  remote: Buffer,
  delta: Buffer,
  signal: AbortSignal
): Promise<void> {
  const existing = await readPlaylist(jobId);
  if (existing && existing.bytes !== remote.length) {
    console.warn(`[Job ${jobId}] live playlist does not match stored audio; leaving segments in place`);
    return;
  }
  let segments: LiveSegment[] = existing ? [...existing.segments] : [];
  if (!existing && remote.length > 0) {
    const remotePackets = await indexMp3Packets(remote);
    const name = "live/0000.mp3";
    if (await fileExists(`audiobooks/${jobId}/${name}`)) return;
    await uploadFile(`audiobooks/${jobId}`, name, remote, "audio/mpeg", { abortSignal: signal });
    segments = [{ uri: name, seconds: mp3IndexedDuration(remotePackets) }];
  }
  const packets = await indexMp3Packets(delta);
  const preferred = `live/${String(segments.length).padStart(4, "0")}.mp3`;
  if (await fileExists(`audiobooks/${jobId}/${preferred}`)) return;
  const name = preferred;
  await uploadFile(`audiobooks/${jobId}`, name, delta, "audio/mpeg", { abortSignal: signal });
  segments.push({ uri: name, seconds: mp3IndexedDuration(packets) });
  const body = hlsEventPlaylist(segments, remote.length + delta.length, false);
  await uploadFile(`audiobooks/${jobId}`, PLAYLIST_FILE, Buffer.from(body), "audio/mpegurl", {
    abortSignal: signal,
  });
}

async function writePlaylistEnd(jobId: string, signal: AbortSignal): Promise<void> {
  const existing = await readPlaylist(jobId);
  if (!existing) return;
  const body = hlsEventPlaylist(existing.segments, existing.bytes ?? 0, true);
  await uploadFile(`audiobooks/${jobId}`, PLAYLIST_FILE, Buffer.from(body), "audio/mpegurl", {
    abortSignal: signal,
  });
}

async function readPlaylist(jobId: string) {
  const key = `audiobooks/${jobId}/${PLAYLIST_FILE}`;
  if (!(await fileExists(key))) return null;
  return readHlsPlaylist((await downloadFile(key)).toString("utf8"));
}

async function joinPrefix(
  jobId: string,
  prefix: JobSegment[],
  joins: SectionJoinKind[],
  crossfadeMs: number,
  flush: boolean
): Promise<{ audio: Buffer; cursor: LiveJoinCursor; joined: number; lastPiece: string } | null> {
  const remembered = memory.get(jobId);
  const resume =
    remembered && remembered.crossfadeMs === crossfadeMs && remembered.joined <= prefix.length
      ? remembered
      : null;
  let audio: Buffer | null = resume?.audio ?? null;
  let cursor: LiveJoinCursor | null = resume?.cursor ?? null;
  let lastPiece = resume?.lastPiece ?? "";
  let pending: string[] = [];
  const start = resume?.joined ?? 0;
  for (let index = start; index < prefix.length; index++) {
    const file = await sectionFile(jobId, prefix[index]!);
    pending.push(file);
    const work = path.join(jobScratchDir(jobId), `fold-${index}`);
    const combined = pending.length === 1 ? file : await forwardFold(pending, work);
    const firstPending = index - pending.length + 1;
    const step = await appendMasteredSection({
      joined: audio,
      cursor,
      previousFile: audio ? lastPiece : null,
      nextFile: combined,
      previousJoin: joins[Math.max(0, firstPending - 1)] ?? joins[0]!,
      nextJoin: joins[firstPending] ?? joins[index]!,
      crossfadeMs,
      workDir: work,
      run: spawnFfmpeg,
      timeoutMs: 120_000,
    });
    if ("rebuild" in step) continue;
    if (!audio && step.cursor.totalSeconds < COPY_JOIN_MIN_SECONDS) continue;
    audio = step.audio;
    cursor = step.cursor;
    lastPiece = combined;
    pending = [];
  }
  if (flush && pending.length > 0 && audio && cursor) {
    const stable = await publishedPrefix(audio, STABLE_HOLD_SECONDS);
    const held = audio.subarray(stable.length);
    const tail = await reencodeTail(held, pending, path.join(jobScratchDir(jobId), "flush-tail"));
    audio = Buffer.concat([stable, tail]);
    const tailPackets = await indexMp3Packets(tail);
    const startAt = stable.length === 0 ? 0 : mp3IndexedDuration(await indexMp3Packets(stable));
    const starts = cursor.sectionStarts.slice();
    while (starts.length < prefix.length) starts.push(startAt);
    cursor = {
      ...cursor,
      sectionStarts: starts,
      totalSeconds: startAt + mp3IndexedDuration(tailPackets),
    };
    pending = [];
  }
  if (flush && !audio && pending.length > 0) {
    const work = path.join(jobScratchDir(jobId), "flush-all");
    const combined = pending.length === 1 ? pending[0]! : await forwardFold(pending, work);
    const joined = await joinMasteredMp3s({
      files: [combined],
      joins: [joins[0] ?? "chapter"],
      crossfadeMs,
      outPath: path.join(work, "full.mp3"),
      workDir: work,
      run: spawnFfmpeg,
      timeoutMs: 120_000,
    });
    audio = await readFile(path.join(work, "full.mp3"));
    cursor = {
      sectionStarts: joined.sectionStarts,
      totalSeconds: joined.totalSeconds,
      lastBodyByte: 0,
      lastHeadSeconds: 0,
    };
    lastPiece = combined;
    pending = [];
  }
  if (!audio || !cursor) return null;
  return {
    audio,
    cursor,
    joined: prefix.length - pending.length,
    lastPiece,
  };
}

/**
 * ID3 chapters and the finished file. The live playlist already ends with
 * the flushed tail; this upload is what a fresh page load and the download
 * play. An open session does not switch onto it.
 */
export async function finalizeLiveJoin(opts: {
  jobId: string;
  total: number;
  holdsLease?: () => Promise<boolean>;
}): Promise<LiveJoinResult | null> {
  const state = await readState(opts.jobId);
  if (!state || state.joined < opts.total || opts.total <= 0) return null;
  if (opts.holdsLease && !(await opts.holdsLease())) return null;
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
      const dest = path.join(scratch, "full-chapters.mp3");
      await muxChaptersIntoMp3({
        run: spawnFfmpeg,
        srcPath: audioPath(opts.jobId),
        destPath: dest,
        workDir: scratch,
        chapters: id3,
        timeoutMs: 60_000,
      });
      if (opts.holdsLease && !(await opts.holdsLease())) return null;
      await uploadFile(
        `audiobooks/${opts.jobId}`,
        "full.mp3",
        await readFile(dest),
        "audio/mpeg"
      );
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
