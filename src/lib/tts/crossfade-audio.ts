/**
 * Soft joins for Whole-book concat. Live Listen streams never use this.
 *
 * WAV / raw PCM: equal-power (quarter-sine) crossfade in-process, after
 * a short edge-silence trim so provider padding does not become a gap.
 * MP3 / Ogg joins are decoded to PCM and use the same fade. Byte-gluing
 * compressed frames is not a success path.
 */

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SectionJoinKind } from "@/lib/tts/types";

export const CROSSFADE_MS_DEFAULT = 120;
export const CROSSFADE_MS_MIN = 80;
export const CROSSFADE_MS_MAX = 150;
/**
 * Click-guard for a mid-paragraph cut. Short enough that split words
 * do not smear, long enough that a non-zero boundary does not tick.
 * Bypasses the 80 ms floor used for paragraph / chapter fades.
 */
export const MICRO_JOIN_FADE_MS = 12;
/** ~−45 dBFS. Only true padding, not the tail of a quiet word. */
export const JOIN_SILENCE_THRESHOLD = 180;
/** Silence left on each edge after a trim, so attacks are not clipped. */
export const JOIN_SILENCE_KEEP_MS = 40;
/** Cap so a real chapter pause inside a section is not eaten. */
export const JOIN_SILENCE_MAX_TRIM_MS = 320;

const BYTES_PER_PCM16_SAMPLE = 2;

export function clampCrossfadeMs(ms?: number): number {
  if (ms === 0) return 0;
  const n = typeof ms === "number" && Number.isFinite(ms) ? ms : CROSSFADE_MS_DEFAULT;
  if (n <= 0) return 0;
  return Math.min(CROSSFADE_MS_MAX, Math.max(CROSSFADE_MS_MIN, Math.round(n)));
}

export function resolveConcatCrossfadeMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.TTS_CONCAT_CROSSFADE_MS;
  if (raw === undefined || raw === "") return CROSSFADE_MS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return CROSSFADE_MS_DEFAULT;
  return clampCrossfadeMs(n);
}

export function resolveJoinFadeMs(
  joinKind: SectionJoinKind | undefined,
  defaultMs: number
): { ms: number; clamp: boolean } {
  if (!(defaultMs > 0)) return { ms: 0, clamp: false };
  if (joinKind === "mid-paragraph") {
    return { ms: MICRO_JOIN_FADE_MS, clamp: false };
  }
  return { ms: clampCrossfadeMs(defaultMs), clamp: true };
}

function resolveFadeMs(durationMs: number, clamp: boolean): number {
  if (!clamp) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
    return Math.min(CROSSFADE_MS_MAX, Math.round(durationMs));
  }
  return clampCrossfadeMs(durationMs);
}

function fadeSamplesFor(
  sampleRate: number,
  durationMs: number,
  clamp = true
): number {
  const ms = resolveFadeMs(durationMs, clamp);
  if (ms <= 0 || sampleRate <= 0) return 0;
  return Math.max(1, Math.round((sampleRate * ms) / 1000));
}

/**
 * Drop provider padding at the edges of one PCM section. Scans only the
 * trim window, so a long book is not walked sample-by-sample. A buffer
 * that is silent all the way through is left alone.
 */
export function trimPcm16EdgeSilence(
  pcm: Buffer,
  sampleRate: number,
  opts?: { threshold?: number; keepMs?: number; maxTrimMs?: number }
): Buffer {
  if (sampleRate <= 0 || pcm.length < BYTES_PER_PCM16_SAMPLE * 2) return pcm;
  const threshold = opts?.threshold ?? JOIN_SILENCE_THRESHOLD;
  const keep = Math.max(
    0,
    Math.round((sampleRate * (opts?.keepMs ?? JOIN_SILENCE_KEEP_MS)) / 1000)
  );
  const maxTrim = Math.max(
    0,
    Math.round(
      (sampleRate * (opts?.maxTrimMs ?? JOIN_SILENCE_MAX_TRIM_MS)) / 1000
    )
  );
  const samples = sampleCount(pcm);
  if (maxTrim <= 0 || samples <= keep * 2) return pcm;

  const scan = maxTrim + keep;
  let leadSilent = 0;
  const leadLimit = Math.min(samples, scan);
  for (let i = 0; i < leadLimit; i++) {
    if (Math.abs(pcm.readInt16LE(i * BYTES_PER_PCM16_SAMPLE)) > threshold) break;
    leadSilent++;
  }
  let tailSilent = 0;
  const tailLimit = Math.min(samples - leadSilent, scan);
  for (let i = 0; i < tailLimit; i++) {
    const idx = samples - 1 - i;
    if (Math.abs(pcm.readInt16LE(idx * BYTES_PER_PCM16_SAMPLE)) > threshold) {
      break;
    }
    tailSilent++;
  }
  if (leadSilent + tailSilent >= samples) return pcm;

  const trimLead = Math.min(maxTrim, Math.max(0, leadSilent - keep));
  const trimTail = Math.min(maxTrim, Math.max(0, tailSilent - keep));
  if (trimLead === 0 && trimTail === 0) return pcm;
  const start = trimLead * BYTES_PER_PCM16_SAMPLE;
  const end = (samples - trimTail) * BYTES_PER_PCM16_SAMPLE;
  if (end - start < BYTES_PER_PCM16_SAMPLE * 2) return pcm;
  return pcm.subarray(start, end);
}

function sampleCount(pcm: Buffer): number {
  return Math.floor(pcm.length / BYTES_PER_PCM16_SAMPLE);
}

/**
 * Equal-power (quarter-sine) crossfade of two 16-bit mono PCM buffers.
 * Output length = left + right − overlap. Constant power through the
 * join, so the middle does not dip the way a linear fade does.
 */
export function crossfadePcm16Mono(
  left: Buffer,
  right: Buffer,
  sampleRate: number,
  durationMs = CROSSFADE_MS_DEFAULT,
  opts?: { clamp?: boolean }
): Buffer {
  if (!left.length) return right;
  if (!right.length) return left;

  const fade = fadeSamplesFor(sampleRate, durationMs, opts?.clamp !== false);
  const leftSamples = sampleCount(left);
  const rightSamples = sampleCount(right);
  if (fade <= 0 || leftSamples < fade || rightSamples < fade) {
    return Buffer.concat([left, right]);
  }

  const outSamples = leftSamples + rightSamples - fade;
  const out = Buffer.alloc(outSamples * BYTES_PER_PCM16_SAMPLE);
  left.copy(out, 0, 0, (leftSamples - fade) * BYTES_PER_PCM16_SAMPLE);

  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    const gainOut = Math.cos(t * Math.PI * 0.5);
    const gainIn = Math.sin(t * Math.PI * 0.5);
    const a = left.readInt16LE((leftSamples - fade + i) * BYTES_PER_PCM16_SAMPLE);
    const b = right.readInt16LE(i * BYTES_PER_PCM16_SAMPLE);
    const mixed = Math.round(a * gainOut + b * gainIn);
    const clipped = Math.max(-32768, Math.min(32767, mixed));
    out.writeInt16LE(clipped, (leftSamples - fade + i) * BYTES_PER_PCM16_SAMPLE);
  }

  right.copy(
    out,
    leftSamples * BYTES_PER_PCM16_SAMPLE,
    fade * BYTES_PER_PCM16_SAMPLE
  );
  return out;
}

export function concatPcm16MonoWithCrossfade(
  parts: Buffer[],
  sampleRate: number,
  durationMs = CROSSFADE_MS_DEFAULT
): Buffer {
  if (parts.length === 0) return Buffer.alloc(0);
  if (parts.length === 1) return parts[0]!;
  const ms = clampCrossfadeMs(durationMs);
  if (ms <= 0) return Buffer.concat(parts);

  const prepared = parts.map((part) => trimPcm16EdgeSilence(part, sampleRate));
  let acc = prepared[0]!;
  for (let i = 1; i < prepared.length; i++) {
    acc = crossfadePcm16Mono(acc, prepared[i]!, sampleRate, ms);
  }
  return acc;
}

/** ffmpeg filter_complex for N same-rate inputs → label `[out]`. */
export function acrossfadeFilterComplex(
  inputCount: number,
  durationSec: number
): string {
  const d = Math.max(0.01, durationSec);
  if (inputCount < 2) return "";
  if (inputCount === 2) {
    return `[0:a][1:a]acrossfade=d=${d}:c1=qsin:c2=qsin[out]`;
  }
  const parts: string[] = [
    `[0:a][1:a]acrossfade=d=${d}:c1=qsin:c2=qsin[a1]`,
  ];
  for (let i = 2; i < inputCount; i++) {
    const prev = `a${i - 1}`;
    const next = i === inputCount - 1 ? "out" : `a${i}`;
    parts.push(`[${prev}][${i}:a]acrossfade=d=${d}:c1=qsin:c2=qsin[${next}]`);
  }
  return parts.join(";");
}

function resolveConcatBin(): string | null {
  const explicit = process.env.FFMPEG_PATH || process.env.TTS_FFMPEG_PATH;
  if (explicit) {
    try {
      accessSync(explicit, constants.X_OK);
      return explicit;
    } catch {
      return null;
    }
  }
  return "ffmpeg";
}

export function ffmpegConcatAvailable(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (env.TTS_CONCAT_FORCE_MISSING_FFMPEG === "1") return false;
  if (env.VERCEL === "1") return false;
  if (env.VITEST && env.TTS_CONCAT_CROSSFADE_FFMPEG !== "1") return false;
  return resolveConcatBin() !== null;
}

export class ConcatAssembleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcatAssembleError";
  }
}

/**
 * Soft-join compressed Whole-book sections when ffmpeg is present.
 * Returns null when ffmpeg is missing — callers must not byte-glue MP3/Ogg.
 */
export async function concatCompressedWithAcrossfade(
  parts: Buffer[],
  extension: "mp3" | "ogg",
  durationMs = CROSSFADE_MS_DEFAULT
): Promise<Buffer | null> {
  if (parts.length < 2) return parts[0] ?? null;
  const ms = clampCrossfadeMs(durationMs);
  if (ms <= 0) return null;
  if (!ffmpegConcatAvailable()) return null;

  const bin = resolveConcatBin();
  if (!bin) return null;

  const dir = await mkdtemp(path.join(tmpdir(), "ec-acrossfade-"));
  try {
    const inputs: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const file = path.join(dir, `${i}.${extension}`);
      await writeFile(file, parts[i]!);
      inputs.push(file);
    }
    const outFile = path.join(dir, `out.${extension}`);
    const filter = acrossfadeFilterComplex(parts.length, ms / 1000);
    const args = [
      "-y",
      ...inputs.flatMap((file) => ["-i", file]),
      "-filter_complex",
      filter,
      "-map",
      "[out]",
      outFile,
    ];

    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`acrossfade timed out: ${stderr.slice(0, 300)}`));
      }, 120_000);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`acrossfade exit ${code}: ${stderr.slice(0, 300)}`));
      });
    });

    return await readFile(outFile);
  } catch (err) {
    console.error(
      "[concat] remux join failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
