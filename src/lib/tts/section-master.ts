/**
 * Master one take-home section as soon as it is synthesized, then join
 * those MP3s at the end without running loudnorm over the book again.
 *
 * Each section gets the podcast chain (EQ, light de-esser, loudnorm to
 * −16 LUFS) and is stored as mono 96 kbps MP3. Finish crossfades those
 * files in one ffmpeg graph and encodes 96 kbps once. An MP3 frame splice
 * of that crossfade clicks, so the join is not a packet copy.
 *
 * A section that fails this pass is stored raw (`mastered` unset). Finish
 * then uses the old full-book encode. DeepFilter opt-in stays on that
 * path too (`TTS_SECTION_MASTER=0` forces it).
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isEmptyOrSilentAudio } from "@/lib/tts/audio-guard";
import {
  ffmpegConcatAvailable,
  resolveJoinFadeMs,
} from "@/lib/tts/crossfade-audio";
import { ensureJobScratchRoot } from "@/lib/tts/job-scratch";
import {
  MASTER_OUTPUT_MP3_BITRATE,
  MASTER_OUTPUT_SAMPLE_RATE,
  masterDenoiseWet,
  masterProfessionalAf,
} from "@/lib/tts/mastering";
import type { SectionJoinKind } from "@/lib/tts/types";

const SAMPLE_RATE = MASTER_OUTPUT_SAMPLE_RATE;

export function shouldSectionMaster(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (env.TTS_SECTION_MASTER === "0") return false;
  if (env.TTS_MASTER_SKIP === "1") return false;
  if (masterDenoiseWet(env) > 0) return false;
  if (env.VERCEL === "1") return false;
  if (env.VITEST && env.TTS_SECTION_MASTER !== "1") return false;
  if (!ffmpegConcatAvailable({ ...env, VITEST: undefined, TTS_CONCAT_CROSSFADE_FFMPEG: "1" })) {
    return false;
  }
  if (env.TTS_SECTION_MASTER === "1") return true;
  if (env.WORKER === "1" || env.TRIGGER === "1" || env.TTS_MASTER_FULL_BOOK === "1") {
    return true;
  }
  return false;
}

function ffmpegBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.FFMPEG_PATH || env.TTS_FFMPEG_PATH || "ffmpeg";
}

function runFfmpeg(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 180_000): void {
  const result = spawnSync(ffmpegBin(env), ["-hide_banner", "-y", ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`ffmpeg exit ${result.status}: ${(result.stderr || "").slice(-400)}`);
  }
}

/** Podcast chain + mono 96 kbps. Null when the pass fails or comes back silent. */
export async function masterSectionBuffer(
  audio: Buffer,
  extension: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<Buffer | null> {
  const dir = await mkdtemp(path.join(await ensureJobScratchRoot(env), "ec-sec-master-"));
  try {
    const src = path.join(dir, `in.${extension || "mp3"}`);
    const out = path.join(dir, "out.mp3");
    await writeFile(src, audio);
    runFfmpeg(
      [
        "-i",
        src,
        "-ac",
        "1",
        "-af",
        masterProfessionalAf(),
        "-ar",
        String(SAMPLE_RATE),
        "-c:a",
        "libmp3lame",
        "-b:a",
        MASTER_OUTPUT_MP3_BITRATE,
        "-reservoir",
        "0",
        out,
      ],
      env
    );
    const mastered = await readFile(out);
    if (isEmptyOrSilentAudio(mastered)) return null;
    return mastered;
  } catch (err) {
    console.warn(
      "[section-master] section pass failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function prepareSectionForStorage(
  audio: Buffer,
  extension: string,
  contentType: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{
  audio: Buffer;
  extension: string;
  contentType: string;
  mastered: boolean;
}> {
  if (!shouldSectionMaster(env)) {
    return { audio, extension, contentType, mastered: false };
  }
  const mastered = await masterSectionBuffer(audio, extension, env);
  if (!mastered) return { audio, extension, contentType, mastered: false };
  return {
    audio: mastered,
    extension: "mp3",
    contentType: "audio/mpeg",
    mastered: true,
  };
}

type Run = (args: string[], timeoutMs: number) => Promise<void>;

/**
 * Crossfade mastered sections and encode once at 96 kbps.
 * Loudnorm already happened per section, so this graph has no filter chain.
 * Throws on a short section or an ffmpeg failure so the caller can use the
 * full-book encode.
 */
export async function joinMasteredMp3s(opts: {
  files: string[];
  joins: SectionJoinKind[];
  crossfadeMs: number;
  outPath: string;
  workDir: string;
  run: Run;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const { files, run, timeoutMs } = opts;
  if (files.length === 0) throw new Error("no mastered sections");
  if (files.length === 1) {
    await run(["-y", "-i", files[0]!, "-c", "copy", opts.outPath], timeoutMs);
    return;
  }

  const fades: number[] = [];
  for (let i = 0; i < files.length - 1; i++) {
    const fade = resolveJoinFadeMs(opts.joins[i + 1], opts.crossfadeMs);
    fades.push(fade.ms > 0 ? fade.ms / 1000 : 0);
  }

  const stages: string[] = [];
  let current = "0:a";
  for (let i = 0; i < fades.length; i++) {
    const next = `${i + 1}:a`;
    const out = i === fades.length - 1 ? "out" : `xf${i}`;
    const seconds = fades[i]!;
    if (seconds <= 0) {
      stages.push(`[${current}][${next}]concat=n=2:v=0:a=1[${out}]`);
    } else {
      stages.push(
        `[${current}][${next}]acrossfade=d=${seconds.toFixed(3)}:c1=qsin:c2=qsin[${out}]`
      );
    }
    current = out;
  }

  await run(
    [
      "-y",
      ...files.flatMap((file) => ["-i", file]),
      "-filter_complex",
      stages.join(";"),
      "-map",
      "[out]",
      "-ac",
      "1",
      "-ar",
      String(SAMPLE_RATE),
      "-c:a",
      "libmp3lame",
      "-b:a",
      MASTER_OUTPUT_MP3_BITRATE,
      opts.outPath,
    ],
    timeoutMs
  );
}

