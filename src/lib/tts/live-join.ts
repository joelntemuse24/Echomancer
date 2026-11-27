import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { downloadFile, downloadFileToPath, fileExists, listFiles, uploadFile } from "@/lib/storage";
import { jobScratchDir } from "@/lib/tts/job-scratch";
import { muxChaptersIntoMp3, type Id3Chapter } from "@/lib/tts/id3-chapters";
import { loadFrozenSectionOutline, PLAYBACK_CHAPTERS_NAME } from "@/lib/tts/frozen-script";
import {
  chapterSpansFromSections,
  playbackChaptersWithTimes,
  type PlaybackChapter,
} from "@/lib/player/playback-chapters";
import {
  HLS_PLAYLIST_CONTENT_TYPE,
  hlsEventPlaylist,
  readHlsPlaylist,
  type LiveSegment,
} from "@/lib/player/live-playlist";
import {
  commitLiveUpload,
  planLiveSegments,
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

/** One start per section inside a copy-concatenated fold. */
export function foldSectionStarts(pieceStart: number, durations: readonly number[]): number[] {
  const starts: number[] = [];
  let at = pieceStart;
  for (const duration of durations) {
    starts.push(at);
    at += duration;
  }
  return starts;
}

/**
 * Replace the single start recorded for a folded piece with one start per
 * section in that piece. The piece start itself stays the first of them.
 */
export function cursorAfterFold(starts: readonly number[], durations: readonly number[]): number[] {
  if (durations.length <= 1) return [...starts];
  const pieceStart = starts[starts.length - 1] ?? 0;
  return [...starts.slice(0, -1), ...foldSectionStarts(pieceStart, durations)];
}

/** Append a start for each section that begins at `firstStart`. */
export function appendFoldStarts(
  starts: readonly number[],
  firstStart: number,
  durations: readonly number[]
): number[] {
  return [...starts, ...foldSectionStarts(firstStart, durations)];
}

async function fileDurations(files: readonly string[]): Promise<number[]> {
  const durations: number[] = [];
  for (const file of files) {
    durations.push(mp3IndexedDuration(await indexMp3Packets(await readFile(file))));
  }
  return durations;
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
      if (opts.flush) await writePlaylistEnd(opts.jobId, published, abort.signal);
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

function liveObjectUri(key: string, jobId: string): string | null {
  const prefix = `audiobooks/${jobId}/live/`;
  if (!key.startsWith(prefix)) return null;
  const name = key.slice(prefix.length);
  return /^\d{4}\.mp3$/.test(name) ? `live/${name}` : null;
}

async function loadLiveFiles(jobId: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  let keys: string[] = [];
  try {
    keys = await listFiles(`audiobooks/${jobId}/live`);
  } catch {
    return files;
  }
  for (const key of keys) {
    const uri = liveObjectUri(key, jobId);
    if (!uri) continue;
    files.set(uri, await downloadFile(key));
  }
  return files;
}

async function segmentSeconds(bytes: Buffer): Promise<number> {
  return mp3IndexedDuration(await indexMp3Packets(bytes));
}

/**
 * Write the new published slice and a playlist that names it. A segment
 * object that is already the right bytes is kept. A mismatch or a missing
 * playlist is rebuilt from the objects that match `full.mp3`.
 */
async function publishSegment(
  jobId: string,
  remote: Buffer,
  delta: Buffer,
  signal: AbortSignal
): Promise<void> {
  const existing = await readPlaylist(jobId);
  const nextIndex = existing?.segments.length ?? 0;
  const nextName = `live/${String(nextIndex).padStart(4, "0")}.mp3`;
  const aligned = existing != null && existing.bytes === remote.length;
  if (aligned && !(await fileExists(`audiobooks/${jobId}/${nextName}`))) {
    await uploadFile(`audiobooks/${jobId}`, nextName, delta, "audio/mpeg", { abortSignal: signal });
    const segments = [
      ...existing.segments,
      { uri: nextName, seconds: await segmentSeconds(delta) },
    ];
    await writePlaylist(jobId, segments, remote.length + delta.length, false, signal);
    return;
  }
  const files = await loadLiveFiles(jobId);
  const planned = planLiveSegments(remote, delta, files);
  const segments: LiveSegment[] = [];
  for (const segment of planned) {
    if (segment.write) {
      await uploadFile(`audiobooks/${jobId}`, segment.uri, segment.bytes, "audio/mpeg", {
        abortSignal: signal,
      });
    }
    segments.push({ uri: segment.uri, seconds: await segmentSeconds(segment.bytes) });
  }
  await writePlaylist(jobId, segments, remote.length + delta.length, false, signal);
}

async function writePlaylist(
  jobId: string,
  segments: readonly LiveSegment[],
  bytes: number,
  complete: boolean,
  signal: AbortSignal
): Promise<void> {
  const body = hlsEventPlaylist(segments, bytes, complete);
  await uploadFile(`audiobooks/${jobId}`, PLAYLIST_FILE, Buffer.from(body), HLS_PLAYLIST_CONTENT_TYPE, {
    abortSignal: signal,
  });
}

/**
 * A crash after the `full.mp3` PUT and before the playlist write leaves the
 * object longer than `#ECH-BYTES` (or with no playlist). The next publish,
 * including a final flush whose delta is empty, rebuilds the missing tail
 * before `#EXT-X-ENDLIST`.
 */
export async function repairPublishedPlaylist(
  jobId: string,
  published: Buffer,
  signal: AbortSignal = new AbortController().signal,
  complete = false
): Promise<void> {
  if (published.length === 0 || remoteIsFinishedBook(published)) return;
  const existing = await readPlaylist(jobId);
  const aligned =
    existing != null && existing.bytes === published.length && existing.segments.length > 0;
  if (aligned && (!complete || existing.complete)) return;
  let segments = existing?.segments ?? [];
  if (!aligned) {
    const files = await loadLiveFiles(jobId);
    const planned = planLiveSegments(published, Buffer.alloc(0), files);
    if (planned.length === 0) return;
    segments = [];
    for (const segment of planned) {
      if (segment.write) {
        await uploadFile(`audiobooks/${jobId}`, segment.uri, segment.bytes, "audio/mpeg", {
          abortSignal: signal,
        });
      }
      segments.push({ uri: segment.uri, seconds: await segmentSeconds(segment.bytes) });
    }
  }
  await writePlaylist(jobId, segments, published.length, complete, signal);
}

async function writePlaylistEnd(jobId: string, published: Buffer, signal: AbortSignal): Promise<void> {
  await repairPublishedPlaylist(jobId, published, signal, true);
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
    const folded = [...pending];
    audio = step.audio;
    cursor = step.cursor;
    if (folded.length > 1) {
      cursor = {
        ...cursor,
        sectionStarts: cursorAfterFold(cursor.sectionStarts, await fileDurations(folded)),
      };
    }
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
    const heldSeconds = held.length === 0 ? 0 : mp3IndexedDuration(await indexMp3Packets(held));
    const durations = await fileDurations(pending);
    const tailSeconds = mp3IndexedDuration(tailPackets);
    const raw = heldSeconds + durations.reduce((sum, value) => sum + value, 0);
    const scale = raw > 0 ? tailSeconds / raw : 1;
    cursor = {
      ...cursor,
      sectionStarts: appendFoldStarts(
        cursor.sectionStarts,
        startAt + heldSeconds * scale,
        durations.map((value) => value * scale)
      ),
      totalSeconds: startAt + tailSeconds,
    };
    pending = [];
  }
  if (flush && !audio && pending.length > 0) {
    const work = path.join(jobScratchDir(jobId), "flush-all");
    const durations = await fileDurations(pending);
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
    const scale =
      durations.reduce((sum, value) => sum + value, 0) > 0
        ? joined.totalSeconds / durations.reduce((sum, value) => sum + value, 0)
        : 1;
    cursor = {
      sectionStarts: foldSectionStarts(
        0,
        durations.map((value) => value * scale)
      ),
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
