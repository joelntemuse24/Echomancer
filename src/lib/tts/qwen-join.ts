/**
 * Join Qwen TTS chunk takes into one MP3.
 *
 * Every chunk is decoded to 24 kHz mono PCM, its provider padding trimmed,
 * its speech level matched to the take median (±6 dB), edge-faded, and set
 * apart by a pause sized to the text boundary. Two optional repairs target
 * what Qwen 3.1 Flash itself emits (see docs/qwen-flash-artifacts.md):
 *
 *  - `deline`: a narrow cut at the fixed ~1.21 kHz resonance every Flash
 *    take carries ("metallic"). Moves the spectrum ≤0.25 dB outside ±200 Hz.
 *  - `degate`: Flash switches speech to digital zero between words
 *    ("patchy"). Each dead run gets a low room-tone bed and the hard edges
 *    get short ramps, so the floor no longer snaps on and off.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { trimPcm16EdgeSilence } from "@/lib/tts/crossfade-audio";
import type { QwenBoundary } from "@/lib/tts/qwen-chunks";

export const QWEN_SAMPLE_RATE = 24_000;

export const QWEN_PAUSE_MS: Record<QwenBoundary, number> = {
  start: 0,
  paragraph: 750,
  sentence: 420,
  clause: 180,
};

/** Equalizer that flattens the Flash resonance (centre Hz, width Hz, gain dB). */
export const QWEN_DELINE = { hz: 1215, widthHz: 90, gainDb: -4.5 };
/** Room-tone bed relative to the 95th-percentile 5 ms frame level. */
export const QWEN_DEGATE_BED_REL_DB = -66;
/** Frames this far under the speech level count as digital silence. */
export const QWEN_DEGATE_DEAD_REL_DB = -75;
export const QWEN_MAX_GAIN_DB = 6;

export type QwenPost = { deline: boolean; degate: boolean };

export function parseQwenPost(raw: string | undefined): QwenPost {
  const v = (raw ?? "deline,degate").toLowerCase();
  if (v === "off" || v === "none" || v === "0") return { deline: false, degate: false };
  const parts = new Set(v.split(/[\s,]+/).filter(Boolean));
  return { deline: parts.has("deline"), degate: parts.has("degate") };
}

function ffmpegBin(): string {
  return process.env.FFMPEG_PATH || process.env.TTS_FFMPEG_PATH || "ffmpeg";
}

function runFfmpegPipe(args: string[], input: Buffer, timeoutMs = 120_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ffmpeg timed out: ${stderr.slice(0, 300)}`));
    }, timeoutMs);
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 300)}`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** Any ffmpeg-readable take → 24 kHz mono s16le PCM. */
export function decodeToPcm16(audio: Buffer): Promise<Buffer> {
  return runFfmpegPipe(
    ["-v", "error", "-nostdin", "-i", "pipe:0", "-ac", "1", "-ar", String(QWEN_SAMPLE_RATE), "-f", "s16le", "pipe:1"],
    audio
  );
}

export function delineFilter(): string {
  const { hz, widthHz, gainDb } = QWEN_DELINE;
  return `equalizer=f=${hz}:t=h:w=${widthHz}:g=${gainDb}`;
}

/**
 * Encodes to a file, not a pipe: LAME writes its gapless header (encoder
 * delay and padding) only to a seekable output. Without it every decode is
 * shifted by ~50 ms of leading silence.
 */
export async function encodePcm16ToMp3(pcm: Buffer, opts: { deline: boolean }): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), "qwen-enc-"));
  const out = path.join(dir, "take.mp3");
  try {
    const args = ["-v", "error", "-nostdin", "-f", "s16le", "-ar", String(QWEN_SAMPLE_RATE), "-ac", "1", "-i", "pipe:0"];
    if (opts.deline) args.push("-af", delineFilter());
    args.push("-c:a", "libmp3lame", "-b:a", "128k", "-y", out);
    await runFfmpegPipe(args, pcm);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function toFloat(pcm: Buffer): Float32Array {
  const n = Math.floor(pcm.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2) / 32768;
  return out;
}

export function toPcm16(x: Float32Array): Buffer {
  const out = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) {
    const v = Math.round(x[i]! * 32768);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
  return out;
}

/** 5 ms frame RMS in dBFS. */
export function frameLevelsDb(x: Float32Array, sampleRate = QWEN_SAMPLE_RATE, frameMs = 5): Float64Array {
  const fr = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const n = Math.floor(x.length / fr);
  const out = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * fr; i < (f + 1) * fr; i++) s += x[i]! * x[i]!;
    out[f] = 20 * Math.log10(Math.sqrt(s / fr) + 1e-12);
  }
  return out;
}

function percentile(values: ArrayLike<number>, p: number): number {
  const a = Array.from(values).sort((x, y) => x - y);
  if (!a.length) return -Infinity;
  const k = (a.length - 1) * (p / 100);
  const lo = Math.floor(k);
  const hi = Math.ceil(k);
  return a[lo]! + (a[hi]! - a[lo]!) * (k - lo);
}

/** Mean power (dBFS) of the frames within 35 dB of the take's loud frames. */
export function speechLevelDb(pcm: Buffer): number | null {
  const e = frameLevelsDb(toFloat(pcm), QWEN_SAMPLE_RATE, 20);
  if (!e.length) return null;
  const floor = percentile(e, 95) - 35;
  let s = 0;
  let n = 0;
  for (const v of e) {
    if (v > floor) {
      s += 10 ** (v / 10);
      n++;
    }
  }
  return n ? 10 * Math.log10(s / n) : null;
}

/** Per-chunk gain (dB) that brings each speech level to the median. */
export function matchGainsDb(levels: (number | null)[], maxDb = QWEN_MAX_GAIN_DB): number[] {
  const known = levels.filter((v): v is number => v !== null && Number.isFinite(v));
  if (!known.length) return levels.map(() => 0);
  const target = percentile(known, 50);
  return levels.map((v) =>
    v === null || !Number.isFinite(v) ? 0 : Math.max(-maxDb, Math.min(maxDb, target - v))
  );
}

function applyGainAndFades(pcm: Buffer, gainDb: number, fadeMs: number): Float32Array {
  const x = toFloat(pcm);
  const g = 10 ** (gainDb / 20);
  const fade = Math.min(Math.floor(x.length / 2), Math.round((QWEN_SAMPLE_RATE * fadeMs) / 1000));
  for (let i = 0; i < x.length; i++) {
    let w = g;
    if (i < fade) w *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
    else if (i >= x.length - fade) w *= 0.5 - 0.5 * Math.cos((Math.PI * (x.length - 1 - i)) / fade);
    x[i] = x[i]! * w;
  }
  return x;
}

/** Small deterministic PRNG so the same takes join to identical bytes. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type DegateOptions = {
  bedRelDb?: number;
  deadRelDb?: number;
  /** Ramp on the speech side of a hard edge. */
  edgeRampMs?: number;
  /** Fade of the bed into and out of each dead run. */
  bedFadeMs?: number;
  seed?: number;
  /**
   * Decay time constant for a word tail chopped from speech level. The last
   * 10 ms is convolved with exponentially decaying noise (a tiny room), so
   * the word dies away over ~40 ms instead of 5. 0 turns it off.
   */
  tailTauMs?: number;
  /** A run counts as a chopped tail when the 15 ms before it reach above this. */
  tailFromRelDb?: number;
};

/**
 * Reverb-style tail for a chopped word: the windowed last 10 ms before
 * `start`, convolved with decaying noise, written into the dead run.
 */
function addDecayTail(
  x: Float32Array,
  start: number,
  end: number,
  tau: number,
  rand: () => number
): boolean {
  const segLen = Math.min(start, Math.round(tau * (10 / 12)));
  if (segLen < 8) return false;
  const irLen = Math.min(end - start, Math.round(tau * 5));
  if (irLen < 8) return false;
  // Rising half-Hann: full weight on the newest samples.
  const seg = new Float32Array(segLen);
  let segPow = 0;
  for (let i = 0; i < segLen; i++) {
    const w = Math.sin((Math.PI * (i + 0.5)) / (2 * segLen));
    seg[i] = x[start - segLen + i]! * w;
    segPow += seg[i]! * seg[i]!;
  }
  if (segPow <= 0) return false;
  const ir = new Float32Array(irLen + segLen);
  for (let n = 0; n < ir.length; n++) ir[n] = (rand() * 2 - 1) * Math.exp(-n / tau);
  // The room has been ringing for the whole segment already, so the tail is
  // at full level on the first sample after the cut instead of building up.
  const tail = new Float32Array(irLen);
  for (let n = 0; n < irLen; n++) {
    let s = 0;
    for (let k = 0; k < segLen; k++) s += seg[segLen - 1 - k]! * ir[n + k]!;
    tail[n] = s;
  }
  let headPow = 0;
  const head = Math.min(irLen, segLen);
  for (let n = 0; n < head; n++) headPow += tail[n]! * tail[n]!;
  if (headPow <= 0) return false;
  // Start near half the level of the last 10 ms.
  const gain = 0.5 * Math.sqrt(segPow / segLen / (headPow / head));
  for (let n = 0; n < irLen; n++) x[start + n] = x[start + n]! + tail[n]! * gain;
  return true;
}

export type DegateStats = { deadRuns: number; deadMs: number; bedDbfs: number | null };

/**
 * Lay a quiet room-tone bed into every run of digital silence and soften
 * the hard edge on each side. Speech samples are left alone except within
 * `edgeRampMs` of a dead run.
 */
export function degatePcm(
  x: Float32Array,
  opts: DegateOptions = {},
  sampleRate = QWEN_SAMPLE_RATE
): DegateStats {
  const frame = Math.round(sampleRate * 0.005);
  const e = frameLevelsDb(x, sampleRate, 5);
  if (e.length < 4) return { deadRuns: 0, deadMs: 0, bedDbfs: null };
  const pk = percentile(e, 95);
  const deadDb = pk + (opts.deadRelDb ?? QWEN_DEGATE_DEAD_REL_DB);
  const bedDbfs = pk + (opts.bedRelDb ?? QWEN_DEGATE_BED_REL_DB);
  const bedRms = 10 ** (bedDbfs / 20);
  const ramp = Math.round((sampleRate * (opts.edgeRampMs ?? 4)) / 1000);
  const bedFade = Math.round((sampleRate * (opts.bedFadeMs ?? 12)) / 1000);
  const tailTau = (sampleRate * (opts.tailTauMs ?? 12)) / 1000;
  const rand = mulberry32(opts.seed ?? 0x51e7);

  // Brown-ish room tone: white noise through a one-pole low-pass (~1.2 kHz),
  // normalised to unit RMS by the filter's power gain.
  const a = Math.exp((-2 * Math.PI * 1200) / sampleRate);
  const norm = Math.sqrt((1 + a) / (1 - a));
  let lp = 0;
  const noise = () => {
    const white = (rand() * 2 - 1) * Math.sqrt(3);
    lp = a * lp + (1 - a) * white;
    return lp * norm;
  };

  let runs = 0;
  let deadSamples = 0;
  let f = 0;
  while (f < e.length) {
    if (e[f]! >= deadDb) {
      f++;
      continue;
    }
    let g = f;
    while (g < e.length && e[g]! < deadDb) g++;
    if (g - f >= 2) {
      const start = f * frame;
      const end = g === e.length ? x.length : g * frame;
      runs++;
      deadSamples += end - start;
      let before = -Infinity;
      for (let k = Math.max(0, f - 3); k < f; k++) before = Math.max(before, e[k]!);
      const chopped = before > pk + (opts.tailFromRelDb ?? -40);
      const tailed = chopped && tailTau > 0 && addDecayTail(x, start, end, tailTau, rand);
      for (let i = 0; !tailed && i < ramp && start - 1 - i >= 0; i++) {
        x[start - 1 - i]! *= 0.5 - 0.5 * Math.cos((Math.PI * i) / ramp);
      }
      for (let i = 0; i < ramp && end + i < x.length; i++) {
        x[end + i]! *= 0.5 - 0.5 * Math.cos((Math.PI * i) / ramp);
      }
      // The bed reaches full level at the gap edge; its fades sit under the
      // neighbouring speech, which masks them.
      const from = Math.max(0, start - bedFade);
      const to = Math.min(x.length, end + bedFade);
      for (let i = from; i < to; i++) {
        let w = 1;
        if (i < start) w = 0.5 - 0.5 * Math.cos((Math.PI * (i - from)) / Math.max(1, start - from));
        else if (i >= end) w = 0.5 - 0.5 * Math.cos((Math.PI * (to - 1 - i)) / Math.max(1, to - end));
        x[i] = x[i]! + noise() * bedRms * w;
      }
    }
    f = g;
  }
  return { deadRuns: runs, deadMs: Math.round((deadSamples / sampleRate) * 1000), bedDbfs };
}

export type QwenJoinPiece = { audio: Buffer; boundary: QwenBoundary };

export type QwenJoinResult = {
  audio: Buffer;
  pcm: Buffer;
  durationSeconds: number;
  gainsDb: number[];
  degate: DegateStats | null;
};

/**
 * Join chunk takes. `decode` is injectable so tests can hand in PCM without
 * ffmpeg; `encode: false` returns PCM only.
 */
export async function joinQwenChunks(
  pieces: QwenJoinPiece[],
  opts: {
    post: QwenPost;
    edgeFadeMs?: number;
    pauses?: Partial<Record<QwenBoundary, number>>;
    degate?: DegateOptions;
    decode?: (audio: Buffer) => Promise<Buffer>;
    encode?: boolean;
  }
): Promise<QwenJoinResult> {
  const decode = opts.decode ?? decodeToPcm16;
  const pauses = { ...QWEN_PAUSE_MS, ...opts.pauses };
  const pcms: Buffer[] = [];
  for (const piece of pieces) {
    const pcm = await decode(piece.audio);
    pcms.push(
      trimPcm16EdgeSilence(pcm, QWEN_SAMPLE_RATE, { keepMs: 30, maxTrimMs: 2000 })
    );
  }
  const gainsDb = matchGainsDb(pcms.map(speechLevelDb));
  const edgeFade = opts.edgeFadeMs ?? 6;

  const parts: Float32Array[] = [];
  let total = 0;
  pcms.forEach((pcm, i) => {
    const gap = i === 0 ? 0 : pauses[pieces[i]!.boundary] ?? pauses.sentence;
    if (gap > 0) {
      const silence = new Float32Array(Math.round((QWEN_SAMPLE_RATE * gap) / 1000));
      parts.push(silence);
      total += silence.length;
    }
    const x = applyGainAndFades(pcm, gainsDb[i]!, edgeFade);
    parts.push(x);
    total += x.length;
  });
  const joined = new Float32Array(total);
  let at = 0;
  for (const p of parts) {
    joined.set(p, at);
    at += p.length;
  }

  const degate = opts.post.degate ? degatePcm(joined, opts.degate) : null;
  const pcm = toPcm16(joined);
  const audio =
    opts.encode === false ? pcm : await encodePcm16ToMp3(pcm, { deline: opts.post.deline });
  return {
    audio,
    pcm,
    durationSeconds: joined.length / QWEN_SAMPLE_RATE,
    gainsDb,
    degate,
  };
}

/** Re-encode one take with the post repairs only (no chunking). */
export async function repairQwenTake(audio: Buffer, post: QwenPost, degate?: DegateOptions): Promise<Buffer> {
  const pcm = await decodeToPcm16(audio);
  const x = toFloat(pcm);
  if (post.degate) degatePcm(x, degate);
  return encodePcm16ToMp3(toPcm16(x), { deline: post.deline });
}
