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
import {
  MASTER_BLEND_DRY,
  MASTER_BLEND_ENHANCED,
  MASTER_LOUDNORM_I,
  MASTER_LOUDNORM_TP,
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
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${path.basename(cmd)} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(
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

function blendFilter(): string {
  return [
    `[0:a]volume=${MASTER_BLEND_ENHANCED}[e]`,
    `[1:a]volume=${MASTER_BLEND_DRY}[d]`,
    `[e][d]amix=inputs=2:duration=first:normalize=0:dropout_transition=0[mix]`,
    `[mix]loudnorm=I=${MASTER_LOUDNORM_I}:TP=${MASTER_LOUDNORM_TP}[out]`,
  ].join(";");
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
    const enhanceDir = path.join(dir, "dfn");
    const outPath = path.join(dir, `out.${format.extension}`);

    await writeFile(inputPath, buffer);
    await mkdir(enhanceDir, { recursive: true });
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

    await runCommand(
      deepFilter,
      ["-o", enhanceDir, "--compensate-delay", dryWav],
      timeoutMs
    );

    const enhancedWav = await findEnhancedWav(enhanceDir, dryWav);

    await runCommand(
      ffmpeg,
      [
        "-y",
        "-i",
        enhancedWav,
        "-i",
        dryWav,
        "-filter_complex",
        blendFilter(),
        "-map",
        "[out]",
        ...encodeArgs(format),
        outPath,
      ],
      timeoutMs
    );

    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
