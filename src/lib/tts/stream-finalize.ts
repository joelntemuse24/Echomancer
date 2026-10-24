/**
 * Whole-book finalize on disk. Node never holds the joined PCM or the
 * finished MP3. Mastered sections are packet-copied; only the crossfade
 * window is re-encoded. Older sections still go through the podcast chain
 * (or loudnorm-only / a joined WAV for DeepFilter).
 */
import { spawn } from "node:child_process";
import { open, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createWavHeader } from "@/lib/tts/pcm-wav";
import {
  ConcatAssembleError,
  CROSSFADE_MS_MAX,
  crossfadePcm16Mono,
  ffmpegConcatAvailable,
  resolveJoinFadeMs,
  planEdgeSilenceTrim,
  JOIN_SILENCE_KEEP_MS,
  JOIN_SILENCE_MAX_TRIM_MS,
} from "@/lib/tts/crossfade-audio";
import {
  MASTER_OUTPUT_MP3_BITRATE,
  MASTER_OUTPUT_SAMPLE_RATE,
  masterDenoiseWet,
  masterLoudnormAf,
  masterProfessionalAf,
} from "@/lib/tts/mastering";
import { createJobScratch, removeJobScratch } from "@/lib/tts/job-scratch";
import { indexMp3Packets, joinMasteredMp3s, masterSectionBuffer, mp3IndexedDuration, withFfmpegSlot } from "@/lib/tts/section-master";
import {
  playbackChaptersWithTimes,
  type ChapterSpan,
} from "@/lib/player/playback-chapters";
import {
  buildId3ChapterTag,
  id3v2HeaderBytes,
  muxChaptersIntoMp3,
  type Id3Chapter,
} from "@/lib/tts/id3-chapters";
import type { SectionJoinKind } from "@/lib/tts/types";

const SAMPLE_RATE = MASTER_OUTPUT_SAMPLE_RATE;
const BYTES_PER_SAMPLE = 2;
/** Edge reads stay under this. A book-length read is a bug. */
export const MAX_EDGE_READ_SAMPLES = SAMPLE_RATE * 2;

export type FinalizeSection = {
  storagePath: string;
  extension: "mp3" | "wav" | "ogg";
  join: SectionJoinKind;
  /** Section file is already the podcast-chain mono MP3. */
  premastered?: boolean;
};

export type StreamFinalizeDeps = {
  download: (storagePath: string, dest: string) => Promise<void>;
  upload: (localPath: string, contentType: string) => Promise<string>;
  /**
   * Upload `prefix` + `localPath` from `skipBytes`. Set by the storage
   * layer so chapter metadata never rewrites the finished file.
   */
  uploadWithPrefix?: (
    prefix: Buffer,
    localPath: string,
    contentType: string,
    skipBytes: number
  ) => Promise<string>;
  run: (args: string[], timeoutMs: number) => Promise<void>;
};

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (true) {
        const i = next;
        next += 1;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!, i);
      }
    })
  );
  return out;
}

export function finalizeEncodeMode(
  env: NodeJS.ProcessEnv = process.env
): "delivery" | "join" | "loudnorm" {
  if (env.TTS_MASTER_SKIP === "1") return "loudnorm";
  if (masterDenoiseWet(env) > 0) return "join";
  return "delivery";
}

export function finalizeFilter(mode: "delivery" | "join" | "loudnorm"): string | null {
  if (mode === "join") return null;
  if (mode === "loudnorm") return masterLoudnormAf();
  return masterProfessionalAf();
}

type WavLayout = {
  dataOffset: number;
  dataBytes: number;
  sampleRate: number;
  channels: number;
  bits: number;
};

async function readWavLayout(file: string): Promise<WavLayout> {
  const fh = await open(file, "r");
  try {
    const head = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    const buf = head.subarray(0, bytesRead);
    if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
      throw new ConcatAssembleError(`not a wav: ${file}`);
    }
    let offset = 12;
    let sampleRate = 0;
    let channels = 0;
    let bits = 0;
    while (offset + 8 <= buf.length) {
      const id = buf.toString("ascii", offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      const dataStart = offset + 8;
      if (id === "fmt " && size >= 16 && dataStart + 16 <= buf.length) {
        channels = buf.readUInt16LE(dataStart + 2);
        sampleRate = buf.readUInt32LE(dataStart + 4);
        bits = buf.readUInt16LE(dataStart + 14);
      } else if (id === "data") {
        return { dataOffset: dataStart, dataBytes: size, sampleRate, channels, bits };
      }
      offset = dataStart + size + (size % 2);
    }
    throw new ConcatAssembleError(`wav data chunk not in header: ${file}`);
  } finally {
    await fh.close();
  }
}

/** Read a bounded PCM range. Refuses a book-length read. */
export async function readWavSampleRange(
  file: string,
  startSample: number,
  sampleCount: number,
  layout?: WavLayout
): Promise<Buffer> {
  if (sampleCount < 0 || sampleCount > MAX_EDGE_READ_SAMPLES) {
    throw new ConcatAssembleError(
      `refusing wav read of ${sampleCount} samples (cap ${MAX_EDGE_READ_SAMPLES})`
    );
  }
  const wav = layout ?? (await readWavLayout(file));
  if (wav.channels !== 1 || wav.bits !== 16) {
    throw new ConcatAssembleError("finalize expects 16-bit mono wav");
  }
  const total = Math.floor(wav.dataBytes / BYTES_PER_SAMPLE);
  const start = Math.max(0, Math.min(total, startSample));
  const count = Math.max(0, Math.min(sampleCount, total - start));
  const out = Buffer.alloc(count * BYTES_PER_SAMPLE);
  if (count === 0) return out;
  const fh = await open(file, "r");
  try {
    await fh.read(out, 0, out.length, wav.dataOffset + start * BYTES_PER_SAMPLE);
    return out;
  } finally {
    await fh.close();
  }
}

function scanWindowSamples(sampleRate: number): number {
  const keep = Math.round((sampleRate * JOIN_SILENCE_KEEP_MS) / 1000);
  const maxTrim = Math.round((sampleRate * JOIN_SILENCE_MAX_TRIM_MS) / 1000);
  return maxTrim + keep;
}

export type SectionSpan = { file: string; start: number; end: number; samples: number };

export type JoinPiece =
  | { kind: "span"; index: number }
  | { kind: "mix"; pcm: Buffer };

/**
 * Same join as the in-memory crossfade: trim edges, then equal-power
 * overlap. Only the fade windows are loaded.
 */
export async function planDiskJoins(
  files: string[],
  joins: SectionJoinKind[],
  crossfadeMs: number
): Promise<{ spans: SectionSpan[]; pieces: JoinPiece[] }> {
  const spans: SectionSpan[] = [];
  for (const file of files) {
    const layout = await readWavLayout(file);
    if (layout.sampleRate !== SAMPLE_RATE) {
      throw new ConcatAssembleError(`expected ${SAMPLE_RATE} Hz, got ${layout.sampleRate}`);
    }
    const samples = Math.floor(layout.dataBytes / BYTES_PER_SAMPLE);
    const scan = Math.min(scanWindowSamples(layout.sampleRate), samples);
    const lead = await readWavSampleRange(file, 0, scan, layout);
    const tail = await readWavSampleRange(file, Math.max(0, samples - scan), scan, layout);
    const trim = planEdgeSilenceTrim(lead, tail, samples, layout.sampleRate);
    const start = trim.trimLead;
    const end = samples - trim.trimTail;
    if (end - start < 2) {
      throw new ConcatAssembleError("section trimmed to nothing");
    }
    spans.push({ file, start, end, samples });
  }

  const pieces: JoinPiece[] = [];
  if (spans.length === 0) return { spans, pieces };
  pieces.push({ kind: "span", index: 0 });
  for (let i = 1; i < spans.length; i++) {
    const fade = resolveJoinFadeMs(joins[i], crossfadeMs);
    const left = spans[i - 1]!;
    const right = spans[i]!;
    const fadeSamples =
      fade.ms <= 0
        ? 0
        : Math.max(1, Math.round((SAMPLE_RATE * fade.ms) / 1000));
    const clampedFade = Math.min(fadeSamples, CROSSFADE_MS_MAX * SAMPLE_RATE);
    const leftAvail = left.end - left.start;
    const rightAvail = right.end - right.start;
    if (
      clampedFade <= 0 ||
      leftAvail < clampedFade ||
      rightAvail < clampedFade
    ) {
      pieces.push({ kind: "span", index: i });
      continue;
    }
    const leftTail = await readWavSampleRange(left.file, left.end - clampedFade, clampedFade);
    const rightHead = await readWavSampleRange(right.file, right.start, clampedFade);
    const mixed = crossfadePcm16Mono(leftTail, rightHead, SAMPLE_RATE, fade.ms, {
      clamp: fade.clamp,
    });
    left.end -= clampedFade;
    right.start += clampedFade;
    pieces.push({ kind: "mix", pcm: mixed });
    pieces.push({ kind: "span", index: i });
  }
  return { spans, pieces };
}

function seconds(samples: number): string {
  return (samples / SAMPLE_RATE).toFixed(9);
}

export function renderFfconcat(spans: SectionSpan[], pieces: JoinPiece[], joinDir: string): string {
  const lines = ["ffconcat version 1.0"];
  let mixIndex = 0;
  for (const piece of pieces) {
    if (piece.kind === "span") {
      const span = spans[piece.index]!;
      if (span.end <= span.start) continue;
      lines.push(`file '${path.resolve(span.file).replace(/\\/g, "/").replace(/'/g, "'\\''")}'`);
      lines.push(`inpoint ${seconds(span.start)}`);
      lines.push(`outpoint ${seconds(span.end)}`);
      // Override the container duration. A wrong WAV duration makes the next
      // file start late, and the encoder fills the gap.
      lines.push(`duration ${seconds(span.end - span.start)}`);
      continue;
    }
    const name = path.join(joinDir, `mix_${String(mixIndex).padStart(4, "0")}.wav`);
    lines.push(`file '${path.resolve(name).replace(/\\/g, "/").replace(/'/g, "'\\''")}'`);
    lines.push(`duration ${seconds(piece.pcm.length / BYTES_PER_SAMPLE)}`);
    mixIndex += 1;
  }
  return lines.join("\n") + "\n";
}

export async function writeMixWavs(pieces: JoinPiece[], joinDir: string): Promise<void> {
  await mkdir(joinDir, { recursive: true });
  let mixIndex = 0;
  for (const piece of pieces) {
    if (piece.kind !== "mix") continue;
    const name = path.join(joinDir, `mix_${String(mixIndex).padStart(4, "0")}.wav`);
    const header = createWavHeader(piece.pcm.length, { sampleRate: SAMPLE_RATE });
    await writeFile(name, Buffer.concat([header, piece.pcm]));
    mixIndex += 1;
  }
}

const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const SECTION_FINALIZE_MASTER_MS = 180_000;

export function spawnFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  const bin = process.env.FFMPEG_PATH || process.env.TTS_FFMPEG_PATH || "ffmpeg";
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-400)}`));
    });
  });
}

async function decodeToWav(
  run: StreamFinalizeDeps["run"],
  src: string,
  dest: string,
  timeoutMs: number,
  maxSeconds?: number,
  filter?: string
): Promise<void> {
  // -t before -i stops a demuxer that trusts a lying duration header
  // (Xing frame count, for example) from padding the WAV out to hours.
  const args = ["-y"];
  if (maxSeconds != null && maxSeconds > 0) {
    args.push("-t", maxSeconds.toFixed(3));
  }
  args.push(
    "-i",
    src,
    "-ac",
    "1",
    "-ar",
    String(SAMPLE_RATE),
    "-c:a",
    "pcm_s16le",
    dest
  );
  if (filter) args.splice(args.length - 1, 0, "-af", filter);
  await run(args, timeoutMs);
}

/** Seconds of audio in an MP3, from its frames. Null when the file is not MP3. */
async function mp3FileDuration(file: string): Promise<number | null> {
  try {
    const packets = await indexMp3Packets(await readFile(file));
    const duration = mp3IndexedDuration(packets);
    return duration > 0 ? duration : null;
  } catch {
    return null;
  }
}

export function plannedJoinSamples(spans: SectionSpan[], pieces: JoinPiece[]): number {
  let samples = 0;
  for (const piece of pieces) {
    if (piece.kind === "span") {
      const span = spans[piece.index];
      if (!span || span.end <= span.start) continue;
      samples += span.end - span.start;
      continue;
    }
    samples += piece.pcm.length / BYTES_PER_SAMPLE;
  }
  return samples;
}

/**
 * Where each section's content starts in the rendered file, from the join
 * plan. A mix piece holds the head of the section that follows it, so that
 * section starts at the mix, not at its body span.
 */
export function plannedSectionStarts(
  spans: SectionSpan[],
  pieces: JoinPiece[]
): { sectionStarts: number[]; totalSeconds: number } {
  const starts = new Array<number>(spans.length).fill(Number.NaN);
  let clock = 0;
  for (let p = 0; p < pieces.length; p++) {
    const piece = pieces[p]!;
    if (piece.kind === "mix") {
      const next = pieces[p + 1];
      if (next?.kind === "span" && Number.isNaN(starts[next.index])) {
        starts[next.index] = clock;
      }
      clock += piece.pcm.length / BYTES_PER_SAMPLE / SAMPLE_RATE;
      continue;
    }
    const span = spans[piece.index]!;
    if (Number.isNaN(starts[piece.index])) starts[piece.index] = clock;
    if (span.end > span.start) clock += (span.end - span.start) / SAMPLE_RATE;
  }
  for (let i = 0; i < starts.length; i++) {
    if (Number.isNaN(starts[i])) starts[i] = 0;
  }
  return { sectionStarts: starts, totalSeconds: clock };
}

/**
 * 128 kbps mono plus a little container slack. A file several times this
 * size is a stretched timeline, not the book. The estimate tracks the
 * upstream 128 kbps ceiling, so it stays tolerant of lower bitrates.
 */
export function encodedMp3TooLarge(bytes: number, samples: number): boolean {
  const seconds = samples / SAMPLE_RATE;
  const expected = seconds * 16_000;
  return bytes > expected * 1.4 + 16_384;
}

/**
 * Download sections, join on disk, encode full.mp3, upload from the file.
 * The scratch directory is removed on success and on failure.
 */
function bookChapterList(
  spans: ChapterSpan[] | undefined,
  sectionStarts: number[] | undefined,
  totalSeconds: number | undefined
): Id3Chapter[] | null {
  if (!spans?.length || !sectionStarts || !(totalSeconds != null && totalSeconds > 0)) {
    return null;
  }
  const timed = playbackChaptersWithTimes(spans, sectionStarts, totalSeconds);
  if (timed.length === 0) return null;
  return timed.map((chapter) => ({
    title: chapter.title,
    startMs: (chapter.startSeconds ?? 0) * 1000,
    endMs: (chapter.endSeconds ?? totalSeconds) * 1000,
  }));
}

export type FinalUpload = {
  storagePath: string;
  chaptersMs: number;
  uploadMs: number;
  finalBytes: number;
};

/**
 * Upload the finished file with chapter metadata. When the storage layer can
 * prepend a prefix, the ID3 tag goes on the wire and the source file is read
 * from its first audio frame; otherwise the old ffmpeg mux writes a copy. A
 * chapter list must never cost the book, so any failure ships the original.
 */
async function uploadBookFile(
  jobId: string,
  outPath: string,
  scratch: string,
  chapters: Id3Chapter[] | null,
  deps: StreamFinalizeDeps,
  timeoutMs: number
): Promise<FinalUpload> {
  const plain = async (): Promise<FinalUpload> => {
    const uploadStarted = Date.now();
    const storagePath = await deps.upload(outPath, "audio/mpeg");
    return {
      storagePath,
      chaptersMs: 0,
      uploadMs: Date.now() - uploadStarted,
      finalBytes: (await stat(outPath)).size,
    };
  };
  if (!chapters) return plain();

  if (deps.uploadWithPrefix) {
    const chaptersStarted = Date.now();
    try {
      const tag = buildId3ChapterTag(chapters);
      // Large enough to read the ID3 tag and the leading Xing/Info frame.
      const head = Buffer.alloc(4096);
      const fh = await open(outPath, "r");
      try {
        const { bytesRead } = await fh.read(head, 0, head.length, 0);
        const skipBytes = id3v2HeaderBytes(head.subarray(0, bytesRead));
        const tagMs = Date.now() - chaptersStarted;
        const uploadStarted = Date.now();
        const storagePath = await deps.uploadWithPrefix(tag, outPath, "audio/mpeg", skipBytes);
        const uploadMs = Date.now() - uploadStarted;
        return {
          storagePath,
          chaptersMs: tagMs,
          uploadMs,
          finalBytes: tag.length + (await stat(outPath)).size - skipBytes,
        };
      } finally {
        await fh.close();
      }
    } catch (err) {
      console.warn(
        `[finalize ${jobId}] chapter tag skipped:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  const chaptersStarted = Date.now();
  const dest = path.join(scratch, "full-chapters.mp3");
  try {
    await muxChaptersIntoMp3({
      run: deps.run,
      srcPath: outPath,
      destPath: dest,
      workDir: scratch,
      chapters,
      timeoutMs,
    });
    const chaptersMs = Date.now() - chaptersStarted;
    const uploadStarted = Date.now();
    const storagePath = await deps.upload(dest, "audio/mpeg");
    return {
      storagePath,
      chaptersMs,
      uploadMs: Date.now() - uploadStarted,
      finalBytes: (await stat(dest)).size,
    };
  } catch (err) {
    console.warn(
      `[finalize ${jobId}] chapter metadata mux skipped:`,
      err instanceof Error ? err.message : err
    );
    return plain();
  }
}

export async function streamFinalizeAudiobook(
  jobId: string,
  sections: FinalizeSection[],
  crossfadeMs: number,
  deps: StreamFinalizeDeps,
  env: NodeJS.ProcessEnv = process.env,
  opts?: { chapters?: ChapterSpan[] }
): Promise<{
  storagePath: string;
  deliveryMastered: boolean;
  /** Measured (copy-join) or planned (full encode) section starts, in seconds. */
  sectionStarts?: number[];
  totalSeconds?: number;
}> {
  if (!ffmpegConcatAvailable(env) && deps.run === spawnFfmpeg) {
    throw new ConcatAssembleError("ffmpeg is not available on this host");
  }
  if (sections.length === 0) throw new ConcatAssembleError("no sections to finalize");
  const scratch = await createJobScratch(jobId, env);
  const timeoutMs = Number(env.TTS_FINALIZE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  const mode = finalizeEncodeMode(env);
  const hasPremastered = sections.some((section) => section.premastered);
  const localFiles = new Map<number, string>();
  let copyJoin = mode === "delivery" && sections.every((section) => section.premastered && section.extension === "mp3");
  let premasterMs = 0;
  let downloadMs = 0;
  try {
    if (hasPremastered && !copyJoin) {
      const premasterStarted = Date.now();
      const downloadsStarted = Date.now();
      await mapLimit(sections, 8, async (section, i) => {
        if (localFiles.has(i)) return;
        const src = path.join(scratch, `mixed_${i}.${section.extension}`);
        await deps.download(section.storagePath, src);
        localFiles.set(i, src);
      });
      downloadMs += Date.now() - downloadsStarted;
      const unmastered = sections.flatMap((section, i) =>
        section.premastered ? [] : [i]
      );
      const mastered = await mapLimit(unmastered, 3, async (i) => {
        const section = sections[i]!;
        const src = localFiles.get(i)!;
        const out = await masterSectionBuffer(await readFile(src), section.extension, env);
        if (!out) return false;
        const dest = path.join(scratch, `mixed_mastered_${i}.mp3`);
        await writeFile(dest, out);
        await rm(src, { force: true });
        localFiles.set(i, dest);
        return true;
      });
      let allMastered = true;
      const masteredIndexes = new Set<number>();
      for (let k = 0; k < unmastered.length; k++) {
        if (mastered[k]) masteredIndexes.add(unmastered[k]!);
        else allMastered = false;
      }
      if (masteredIndexes.size > 0) {
        sections = sections.map((item, index) =>
          masteredIndexes.has(index)
            ? { ...item, extension: "mp3", premastered: true }
            : item
        );
      }
      copyJoin = allMastered && sections.every((section) => section.extension === "mp3");
      premasterMs = Date.now() - premasterStarted;
    }
    if (copyJoin) {
      try {
        const mp3s = new Array<string>(sections.length);
        const downloadStarted = Date.now();
        await mapLimit(sections, 8, async (section, i) => {
          const src = localFiles.get(i) ?? path.join(scratch, `pre_${String(i).padStart(4, "0")}.mp3`);
          if (!localFiles.has(i)) await deps.download(section.storagePath, src);
          localFiles.set(i, src);
          mp3s[i] = src;
        });
        downloadMs += Date.now() - downloadStarted;
        const outPath = path.join(scratch, "full.mp3");
        const joinStarted = Date.now();
        const joined = await joinMasteredMp3s({
          files: mp3s,
          joins: sections.map((section) => section.join),
          crossfadeMs,
          outPath,
          workDir: scratch,
          run: deps.run,
          timeoutMs,
          env,
        });
        const joinMs = Date.now() - joinStarted;
        const uploaded = await uploadBookFile(
          jobId,
          outPath,
          scratch,
          bookChapterList(opts?.chapters, joined.sectionStarts, joined.totalSeconds),
          deps,
          timeoutMs
        );
        console.log(
          `[finalize ${jobId}] joined ${sections.length} mastered sections in ${Date.now() - started}ms download=${downloadMs} join=${joinMs} upload=${uploaded.uploadMs} premaster=${premasterMs} chapters=${uploaded.chaptersMs} bytes=${uploaded.finalBytes}`
        );
        return {
          storagePath: uploaded.storagePath,
          deliveryMastered: true,
          sectionStarts: joined.sectionStarts,
          totalSeconds: joined.totalSeconds,
        };
      } catch (err) {
        console.warn(
          `[finalize ${jobId}] mastered join failed, full encode:`,
          err instanceof Error ? err.message : err
        );
      }
    }
    const premasteredFallback = copyJoin || hasPremastered;

    const wavs: string[] = [];
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i]!;
      const src = localFiles.get(i) ?? path.join(scratch, `in_${String(i).padStart(4, "0")}.${section.extension}`);
      const wav = path.join(scratch, `sec_${String(i).padStart(4, "0")}.wav`);
      if (!localFiles.has(i)) {
        const downloadStarted = Date.now();
        await deps.download(section.storagePath, src);
        downloadMs += Date.now() - downloadStarted;
      }
      const decodedSeconds =
        section.extension === "mp3" ? await mp3FileDuration(src) : null;
      const decode = () => decodeToWav(
        deps.run,
        src,
        wav,
        hasPremastered && !section.premastered ? Math.min(timeoutMs, SECTION_FINALIZE_MASTER_MS) : timeoutMs,
        decodedSeconds == null ? undefined : decodedSeconds + 0.25,
        hasPremastered && !section.premastered ? masterProfessionalAf() : undefined
      );
      if (hasPremastered && !section.premastered) await withFfmpegSlot(decode);
      else await decode();
      await rm(src, { force: true });
      wavs.push(wav);
    }

    const joinStarted = Date.now();
    const joins = sections.map((section) => section.join);
    const planned = await planDiskJoins(wavs, joins, crossfadeMs);
    const joinDir = path.join(scratch, "joins");
    await writeMixWavs(planned.pieces, joinDir);
    const list = renderFfconcat(planned.spans, planned.pieces, joinDir);
    const listPath = path.join(scratch, "book.ffconcat");
    await writeFile(listPath, list);
    const joinMs = Date.now() - joinStarted;

    const joinedWav = path.join(scratch, "joined.wav");
    const outPath = path.join(scratch, "full.mp3");
    const plannedSamples = plannedJoinSamples(planned.spans, planned.pieces);
    const outputCap = (plannedSamples / SAMPLE_RATE + 1).toFixed(3);
    const encode = async (filter: string | null, dest: string) => {
      const args = ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-ac", "1", "-t", outputCap];
      if (filter) args.push("-af", filter);
      if (dest.endsWith(".wav")) {
        args.push("-ar", String(SAMPLE_RATE), "-c:a", "pcm_s16le", dest);
      } else {
        args.push(
          "-ar",
          String(SAMPLE_RATE),
          "-c:a",
          "libmp3lame",
          "-b:a",
          MASTER_OUTPUT_MP3_BITRATE,
          dest
        );
      }
      await deps.run(args, timeoutMs);
    };

    let deliveryMastered = false;
    if (mode === "join" && !premasteredFallback) {
      await encode(null, joinedWav);
      try {
        const worker = await import(
          /* webpackIgnore: true */
          "./mastering-worker"
        );
        await worker.remasterAudioFile(joinedWav, outPath);
        deliveryMastered = true;
      } catch (err) {
        console.warn(
          `[finalize ${jobId}] DeepFilter file remaster failed, delivery chain:`,
          err instanceof Error ? err.message : err
        );
        await encode(masterProfessionalAf(), outPath);
        deliveryMastered = true;
      }
    } else if (premasteredFallback) {
      // Each section was already loudnormed. A second one-pass on a short
      // book lands near −17 LUFS instead of −16.
      await encode(null, outPath);
      deliveryMastered = true;
    } else if (mode === "loudnorm") {
      await encode(masterLoudnormAf(), outPath);
    } else {
      try {
        await encode(masterProfessionalAf(), outPath);
        deliveryMastered = true;
      } catch (err) {
        console.warn(
          `[finalize ${jobId}] delivery chain failed, loudnorm-only:`,
          err instanceof Error ? err.message : err
        );
        await encode(masterLoudnormAf(), outPath);
      }
    }

    const encodedBytes = (await stat(outPath)).size;
    if (encodedMp3TooLarge(encodedBytes, plannedSamples)) {
      throw new ConcatAssembleError(
        `full encode is ${encodedBytes} bytes; ${Math.round((plannedSamples / SAMPLE_RATE) * 16_000)} bytes is the 128 kbps size of the decoded audio`
      );
    }
    const timing = plannedSectionStarts(planned.spans, planned.pieces);
    const uploaded = await uploadBookFile(
      jobId,
      outPath,
      scratch,
      bookChapterList(opts?.chapters, timing.sectionStarts, timing.totalSeconds),
      deps,
      timeoutMs
    );
    console.log(
      `[finalize ${jobId}] streamed ${sections.length} sections in ${Date.now() - started}ms mode=${mode} mastered=${deliveryMastered} premaster=${premasterMs} download=${downloadMs} join=${joinMs} chapters=${uploaded.chaptersMs} upload=${uploaded.uploadMs} bytes=${uploaded.finalBytes}`
    );
    return {
      storagePath: uploaded.storagePath,
      deliveryMastered,
      sectionStarts: timing.sectionStarts,
      totalSeconds: timing.totalSeconds,
    };
  } finally {
    await removeJobScratch(jobId, env);
  }
}
