/**
 * Trigger.dev-only spawn pipeline: DeepFilterNet3 `deep-filter` + ffmpeg
 * amix 0.7/0.3 + loudnorm.
 *
 * Do not import this module from `src/app/api/**`. It is loaded via a
 * webpack-ignored dynamic import from `mastering.ts` after the Vercel
 * host check fails closed. No ffmpeg/torch npm packages.
 */

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isEmptyOrSilentAudio } from "@/lib/tts/audio-guard";
import {
  DFN3_DELAY_SAMPLES_48K,
  MASTER_DFN_CHUNK_SECONDS,
  masterBlendFilterComplex,
  type MasterableAudioFormat,
} from "@/lib/tts/mastering";

const DEFAULT_TIMEOUT_MS = 50 * 60 * 1000;

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveDeepFilterBin(): string {
  const candidates = [
    process.env.DEEP_FILTER_BIN,
    process.env.TTS_DEEP_FILTER_BIN,
    "/usr/local/bin/deep-filter",
    path.join(process.cwd(), "vendor/deep-filter/deep-filter"),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }
  throw new Error(
    "deep-filter binary not found (Trigger image should set DEEP_FILTER_BIN)"
  );
}

export function resolveFfmpegBin(): string {
  const explicit = process.env.FFMPEG_PATH || process.env.TTS_FFMPEG_PATH;
  if (explicit && isExecutable(explicit)) return explicit;
  return "ffmpeg";
}

function runCommand(
  cmd: string,
  args: string[],
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        new Error(`${path.basename(cmd)} timed out after ${timeoutMs}ms`)
      );
    }, timeoutMs);
    child.on("error", (err) => finish(err));
    child.on("close", (code) => {
      if (code === 0) {
        finish();
        return;
      }
      finish(
        new Error(
          `${path.basename(cmd)} exited ${code}: ${stderr.trim() || "no stderr"}`
        )
      );
    });
  });
}

function encodeArgs(format: MasterableAudioFormat): string[] {
  if (format.extension === "wav") return ["-c:a", "pcm_s16le"];
  if (format.extension === "ogg") return ["-c:a", "libvorbis", "-q:a", "4"];
  return ["-c:a", "libmp3lame", "-q:a", "2"];
}

async function findEnhancedWav(
  enhanceDir: string,
  dryWavPath: string
): Promise<string> {
  const names = await readdir(enhanceDir);
  const wavs = names
    .filter((name) => name.toLowerCase().endsWith(".wav"))
    .map((name) => path.join(enhanceDir, name));
  const dryResolved = path.resolve(dryWavPath);
  const enhanced = wavs.find((file) => path.resolve(file) !== dryResolved);
  if (enhanced) return enhanced;
  if (wavs[0]) return wavs[0];
  throw new Error("deep-filter produced no WAV output");
}

function wavPcmDurationSeconds(buffer: Buffer): number | null {
  if (buffer.length < 44) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buffer.toString("ascii", 8, 12) !== "WAVE") return null;
  let offset = 12;
  let sampleRate = 0;
  let numChannels = 0;
  let bitDepth = 0;
  let dataBytes = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (id === "fmt " && size >= 16 && dataStart + 16 <= buffer.length) {
      numChannels = buffer.readUInt16LE(dataStart + 2);
      sampleRate = buffer.readUInt32LE(dataStart + 4);
      bitDepth = buffer.readUInt16LE(dataStart + 14);
    } else if (id === "data") {
      dataBytes = Math.max(0, Math.min(size, buffer.length - dataStart));
      break;
    }
    offset = dataStart + size + (size % 2);
  }
  const bytesPerSec = sampleRate * numChannels * (bitDepth / 8);
  if (bytesPerSec <= 0) return null;
  return dataBytes / bytesPerSec;
}

async function enhanceWav(
  ffmpeg: string,
  deepFilter: string,
  dryWav: string,
  workDir: string,
  timeoutMs: number
): Promise<string> {
  const enhanceDir = path.join(workDir, "dfn");
  await mkdir(enhanceDir, { recursive: true });

  const dry = await readFile(dryWav);
  const duration = wavPcmDurationSeconds(dry) ?? 0;
  const chunkSec = Number(
    process.env.TTS_MASTER_DFN_CHUNK_SECONDS || MASTER_DFN_CHUNK_SECONDS
  );

  if (duration <= chunkSec + 1) {
    await runCommand(
      deepFilter,
      ["-o", enhanceDir, "--compensate-delay", dryWav],
      timeoutMs
    );
    return findEnhancedWav(enhanceDir, dryWav);
  }

  const chunkIn = path.join(enhanceDir, "in");
  const chunkOut = path.join(enhanceDir, "out");
  await mkdir(chunkIn, { recursive: true });
  await mkdir(chunkOut, { recursive: true });
  await runCommand(
    ffmpeg,
    [
      "-y",
      "-i",
      dryWav,
      "-f",
      "segment",
      "-segment_time",
      String(chunkSec),
      "-reset_timestamps",
      "1",
      "-c",
      "copy",
      path.join(chunkIn, "part_%03d.wav"),
    ],
    timeoutMs
  );

  const parts = (await readdir(chunkIn))
    .filter((name) => name.toLowerCase().endsWith(".wav"))
    .sort();
  if (parts.length === 0) {
    throw new Error("ffmpeg produced no DFN chunks");
  }

  const enhancedParts: string[] = [];
  for (const part of parts) {
    const inPath = path.join(chunkIn, part);
    const oneOut = path.join(chunkOut, path.parse(part).name);
    await mkdir(oneOut, { recursive: true });
    await runCommand(
      deepFilter,
      ["-o", oneOut, inPath],
      timeoutMs
    );
    enhancedParts.push(await findEnhancedWav(oneOut, inPath));
  }

  const listFile = path.join(enhanceDir, "concat.txt");
  await writeFile(
    listFile,
    enhancedParts
      .map((file) => `file '${file.replace(/'/g, "'\\''")}'`)
      .join("\n")
  );
  const joined = path.join(enhanceDir, "joined.wav");
  await runCommand(
    ffmpeg,
    ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", joined],
    timeoutMs
  );

  const trimmed = path.join(enhanceDir, "enhanced.wav");
  await runCommand(
    ffmpeg,
    [
      "-y",
      "-i",
      joined,
      "-af",
      `atrim=start_sample=${DFN3_DELAY_SAMPLES_48K}`,
      "-c:a",
      "pcm_s16le",
      trimmed,
    ],
    timeoutMs
  );
  return trimmed;
}

/**
 * DFN3 enhance the concat, blend 70/30 with the dry file, loudnorm, re-encode.
 */
export async function enhanceConcatenatedAudiobook(
  buffer: Buffer,
  format: MasterableAudioFormat
): Promise<Buffer> {
  const ffmpeg = resolveFfmpegBin();
  const deepFilter = resolveDeepFilterBin();
  const timeoutMs = Number(
    process.env.TTS_MASTER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS
  );
  const dir = await mkdtemp(path.join(tmpdir(), "ec-master-"));

  try {
    const inputPath = path.join(dir, `input.${format.extension}`);
    const dryWav = path.join(dir, "dry.wav");
    const outPath = path.join(dir, `out.${format.extension}`);

    await writeFile(inputPath, buffer);
    await runCommand(
      ffmpeg,
      [
        "-y",
        "-i",
        inputPath,
        "-ac",
        "1",
        "-ar",
        "48000",
        "-c:a",
        "pcm_s16le",
        dryWav,
      ],
      timeoutMs
    );

    const enhancedWav = await enhanceWav(
      ffmpeg,
      deepFilter,
      dryWav,
      dir,
      timeoutMs
    );

    await runCommand(
      ffmpeg,
      [
        "-y",
        "-i",
        enhancedWav,
        "-i",
        dryWav,
        "-filter_complex",
        masterBlendFilterComplex(),
        "-map",
        "[out]",
        ...encodeArgs(format),
        outPath,
      ],
      timeoutMs
    );

    const mastered = await readFile(outPath);
    if (isEmptyOrSilentAudio(mastered)) {
      throw new Error("mastering produced silent audio");
    }
    return mastered;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
