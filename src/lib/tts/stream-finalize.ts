/**
 * Whole-book finalize on disk. Node never holds the joined PCM or the
 * finished MP3. ffmpeg streams the concat demuxer through the podcast
 * chain (or loudnorm-only / a joined WAV for DeepFilter).
 */
import { spawn } from "node:child_process";
import { open, mkdir, rm, writeFile } from "node:fs/promises";
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
import type { SectionJoinKind } from "@/lib/tts/types";

const SAMPLE_RATE = MASTER_OUTPUT_SAMPLE_RATE;
const BYTES_PER_SAMPLE = 2;
/** Edge reads stay under this. A book-length read is a bug. */
export const MAX_EDGE_READ_SAMPLES = SAMPLE_RATE * 2;

export type FinalizeSection = {
  storagePath: string;
  extension: "mp3" | "wav" | "ogg";
  join: SectionJoinKind;
};

export type StreamFinalizeDeps = {
  download: (storagePath: string, dest: string) => Promise<void>;
  upload: (localPath: string, contentType: string) => Promise<string>;
  run: (args: string[], timeoutMs: number) => Promise<void>;
};

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
      lines.push(`file '${span.file.replace(/'/g, "'\\''")}'`);
      lines.push(`inpoint ${seconds(span.start)}`);
      lines.push(`outpoint ${seconds(span.end)}`);
      continue;
    }
    const name = path.join(joinDir, `mix_${String(mixIndex).padStart(4, "0")}.wav`);
    lines.push(`file '${name.replace(/'/g, "'\\''")}'`);
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
  timeoutMs: number
): Promise<void> {
  await run(
    [
      "-y",
      "-i",
      src,
      "-ac",
      "1",
      "-ar",
      String(SAMPLE_RATE),
      "-c:a",
      "pcm_s16le",
      dest,
    ],
    timeoutMs
  );
}

/**
 * Download sections, join on disk, encode full.mp3, upload from the file.
 * The scratch directory is removed on success and on failure.
 */
export async function streamFinalizeAudiobook(
  jobId: string,
  sections: FinalizeSection[],
  crossfadeMs: number,
  deps: StreamFinalizeDeps,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ storagePath: string; deliveryMastered: boolean }> {
  if (!ffmpegConcatAvailable(env) && deps.run === spawnFfmpeg) {
    throw new ConcatAssembleError("ffmpeg is not available on this host");
  }
  if (sections.length === 0) throw new ConcatAssembleError("no sections to finalize");
  const scratch = await createJobScratch(jobId, env);
  const timeoutMs = Number(env.TTS_FINALIZE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  try {
    const wavs: string[] = [];
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i]!;
      const src = path.join(scratch, `in_${String(i).padStart(4, "0")}.${section.extension}`);
      const wav = path.join(scratch, `sec_${String(i).padStart(4, "0")}.wav`);
      await deps.download(section.storagePath, src);
      await decodeToWav(deps.run, src, wav, timeoutMs);
      await rm(src, { force: true });
      wavs.push(wav);
    }

    const joins = sections.map((section) => section.join);
    const planned = await planDiskJoins(wavs, joins, crossfadeMs);
    const joinDir = path.join(scratch, "joins");
    await writeMixWavs(planned.pieces, joinDir);
    const list = renderFfconcat(planned.spans, planned.pieces, joinDir);
    const listPath = path.join(scratch, "book.ffconcat");
    await writeFile(listPath, list);

    const mode = finalizeEncodeMode(env);
    const joinedWav = path.join(scratch, "joined.wav");
    const outPath = path.join(scratch, "full.mp3");
    const encode = async (filter: string | null, dest: string) => {
      const args = ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-ac", "1"];
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
    if (mode === "join") {
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

    const storagePath = await deps.upload(outPath, "audio/mpeg");
    console.log(
      `[finalize ${jobId}] streamed ${sections.length} sections in ${Date.now() - started}ms mode=${mode} mastered=${deliveryMastered}`
    );
    return { storagePath, deliveryMastered };
  } finally {
    await removeJobScratch(jobId, env);
  }
}
