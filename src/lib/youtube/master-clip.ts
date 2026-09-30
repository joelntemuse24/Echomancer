/**
 * Turn a downloaded section into a mono 44.1 kHz voice sample.
 *
 * Loudness-normalize always. Denoise only when the noise floor is close
 * to the voice. Vocal separation (Demucs when installed) runs only when
 * the clip is speech with a music bed — a clean stretch skips it.
 * Music throughout, overlapping speakers, and under ~8s of speech are
 * refused in plain language.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseWavPcm } from "@/lib/tts/clone-sample-audio";
import { YOUTUBE_COPY } from "@/lib/youtube/messages";
import { probeMediaDuration } from "@/lib/youtube/fetch-audio";
import {
  judgeSpeech,
  MIN_SPEECH_SEC,
  pcm16ToMonoFloat,
  type SpeechJudgement,
} from "@/lib/youtube/speech-judge";

export type MasteredClip = {
  wav: Buffer;
  speechSec: number;
  denoise: boolean;
  separated: boolean;
  judgement: SpeechJudgement;
};

export type MasterReject = {
  ok: false;
  code: "music" | "overlap" | "short_speech" | "separate_failed";
  message: string;
};

export function ffmpegBin(): string {
  return process.env.FFMPEG_PATH?.trim() || process.env.TTS_FFMPEG_PATH?.trim() || "ffmpeg";
}

export async function masterYoutubeClip(inputPath: string): Promise<
  | { ok: true; clip: MasteredClip }
  | MasterReject
> {
  const dir = await mkdtemp(path.join(tmpdir(), "echo-yt-master-"));
  try {
    const decoded = path.join(dir, "decoded.wav");
    await runFfmpeg([
      "-y",
      "-i",
      inputPath,
      "-ac",
      "1",
      "-ar",
      "44100",
      "-c:a",
      "pcm_s16le",
      decoded,
    ]);
    const first = await judgeWav(decoded);
    if (!first.ok) {
      return {
        ok: false,
        code: first.code || "short_speech",
        message: first.message || YOUTUBE_COPY.shortSpeech,
      };
    }

    let source = decoded;
    let separated = false;
    let denoise = first.denoise;
    let judgement = first;

    if (first.separateVocals) {
      const vocals = path.join(dir, "vocals.wav");
      const mode = await separateVocals(decoded, vocals, dir);
      if (!mode) {
        return { ok: false, code: "separate_failed", message: YOUTUBE_COPY.separateFailed };
      }
      const again = await judgeWav(vocals);
      if (!again.ok) {
        return {
          ok: false,
          code: again.code || "music",
          message: again.message || YOUTUBE_COPY.music,
        };
      }
      if (again.separateVocals && (mode === "demucs" || again.musicFraction >= 0.45)) {
        return { ok: false, code: "music", message: YOUTUBE_COPY.music };
      }
      source = vocals;
      separated = mode === "demucs";
      denoise = again.denoise;
      judgement = again;
    }

    const finished = path.join(dir, "mastered.wav");
    await finishWav(source, finished, denoise);
    const duration = await probeMediaDuration(finished);
    if (duration != null && duration < MIN_SPEECH_SEC) {
      return { ok: false, code: "short_speech", message: YOUTUBE_COPY.shortSpeech };
    }
    const wav = await readFile(finished);
    if (wav.byteLength < 8 * 1024) {
      return { ok: false, code: "short_speech", message: YOUTUBE_COPY.shortSpeech };
    }
    return {
      ok: true,
      clip: {
        wav,
        speechSec: judgement.speechSec,
        denoise,
        separated,
        judgement,
      },
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function judgeWav(filePath: string): Promise<SpeechJudgement> {
  const buf = await readFile(filePath);
  const parsed = parseWavPcm(buf);
  if (!parsed) {
    return {
      ok: false,
      code: "short_speech",
      message: YOUTUBE_COPY.shortSpeech,
      speechSec: 0,
      denoise: false,
      separateVocals: false,
      musicFraction: 0,
      overlapFraction: 0,
    };
  }
  return judgeSpeech(pcm16ToMonoFloat(parsed.pcm, parsed.numChannels), parsed.sampleRate);
}

async function separateVocals(
  inputWav: string,
  outputWav: string,
  workDir: string
): Promise<"demucs" | "ffmpeg" | null> {
  if (process.env.YT_VOCAL_SEPARATION === "0") {
    return emphasizeVocals(inputWav, outputWav);
  }
  const demucs = await runDemucs(inputWav, outputWav, workDir);
  if (demucs) return "demucs";
  return emphasizeVocals(inputWav, outputWav);
}

async function runDemucs(
  inputWav: string,
  outputWav: string,
  workDir: string
): Promise<boolean> {
  const bin = process.env.DEMUCS_BIN?.trim();
  const args = bin
    ? ["--two-stems=vocals", "-n", "htdemucs", "--segment", "4", "-o", workDir, inputWav]
    : ["-m", "demucs", "--two-stems=vocals", "-n", "htdemucs", "--segment", "4", "-o", workDir, inputWav];
  const command = bin || "python3";
  const result = await runCommand(command, args, 25_000);
  if (result.code !== 0) return false;
  const stem = path.basename(inputWav, path.extname(inputWav));
  const vocals = path.join(workDir, "htdemucs", stem, "vocals.wav");
  const moved = await runFfmpeg([
    "-y",
    "-i",
    vocals,
    "-ac",
    "1",
    "-ar",
    "44100",
    "-c:a",
    "pcm_s16le",
    outputWav,
  ]).then(
    () => true,
    () => false
  );
  return moved;
}

/** Light band-limit + denoise when Demucs is not installed. */
async function emphasizeVocals(inputWav: string, outputWav: string): Promise<"ffmpeg" | null> {
  try {
    await runFfmpeg([
      "-y",
      "-i",
      inputWav,
      "-af",
      "highpass=f=100,lowpass=f=7000,afftdn=nr=10:nf=-25",
      "-ac",
      "1",
      "-ar",
      "44100",
      "-c:a",
      "pcm_s16le",
      outputWav,
    ]);
    return "ffmpeg";
  } catch {
    return null;
  }
}

async function finishWav(inputWav: string, outputWav: string, denoise: boolean): Promise<void> {
  const prep = [
    "highpass=f=80",
    denoise ? "afftdn=nr=8:nf=-28" : "",
    silenceFilter(true),
  ]
    .filter(Boolean)
    .join(",");
  try {
    await loudnorm(inputWav, outputWav, prep);
  } catch {
    const legacy = [
      "highpass=f=80",
      denoise ? "afftdn=nr=8:nf=-28" : "",
      silenceFilter(false),
    ]
      .filter(Boolean)
      .join(",");
    await loudnorm(inputWav, outputWav, legacy);
  }
}

function silenceFilter(modern: boolean): string {
  if (modern) {
    return "silenceremove=start_periods=1:start_duration=0.12:start_threshold=-42dB:stop_periods=1:stop_duration=0.18:stop_threshold=-42dB";
  }
  return "silenceremove=start_periods=1:start_silence=0.12:start_threshold=-42dB:stop_periods=1:stop_silence=0.18:stop_threshold=-42dB";
}

async function loudnorm(inputWav: string, outputWav: string, prep: string): Promise<void> {
  const measured = await runFfmpeg([
    "-hide_banner",
    "-i",
    inputWav,
    "-af",
    `${prep},loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json`,
    "-f",
    "null",
    "-",
  ], true);
  const json = extractLoudnormJson(measured);
  const chain = json
    ? `${prep},loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${json.input_i}:measured_TP=${json.input_tp}:measured_LRA=${json.input_lra}:measured_thresh=${json.input_thresh}:offset=${json.target_offset}:linear=true`
    : `${prep},loudnorm=I=-16:TP=-1.5:LRA=11`;
  await runFfmpeg([
    "-y",
    "-i",
    inputWav,
    "-af",
    chain,
    "-ac",
    "1",
    "-ar",
    "44100",
    "-c:a",
    "pcm_s16le",
    outputWav,
  ]);
}

function extractLoudnormJson(stderr: string): {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
} | null {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
    if (!parsed.input_i || !parsed.input_tp || !parsed.input_lra || !parsed.input_thresh || !parsed.target_offset) {
      return null;
    }
    if (parsed.input_i === "-inf") return null;
    return {
      input_i: parsed.input_i,
      input_tp: parsed.input_tp,
      input_lra: parsed.input_lra,
      input_thresh: parsed.input_thresh,
      target_offset: parsed.target_offset,
    };
  } catch {
    return null;
  }
}

async function runFfmpeg(args: string[], keepStderr = false): Promise<string> {
  const result = await runCommand(ffmpegBin(), ["-hide_banner", ...args], 30_000);
  if (result.code !== 0) {
    throw new Error(result.stderr.slice(-400) || "ffmpeg failed");
  }
  return keepStderr ? result.stderr : "";
}

function runCommand(
  bin: string,
  args: string[],
  timeoutMs: number
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = "";
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stderr: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}
