/**
 * Master one take-home section as soon as it is synthesized, then join
 * those MP3s at the end without running loudnorm over the book again.
 *
 * Each section gets the podcast chain (EQ, light de-esser, loudnorm to
 * −16 LUFS) and is stored as mono 128 kbps MP3. The loudnorm gain is
 * measured, then applied, so a short section does not sit quiet of −16.
 * Finish packet-copies those files and re-encodes only the crossfade
 * window (under two seconds). The cut is the frame whose splice step
 * matches the audio beside it. A consonant elsewhere in the window is
 * not a click. A bad frame is not used. A section under four seconds
 * (a heading, or a blank) is re-encoded with that same crossfade into
 * the next section — the previous section, at the end of the book —
 * and the rest of the neighbor stays a packet copy. One short section
 * does not send the book through a full encode.
 *
 * A section that fails this pass is stored raw (`mastered` unset). Finish
 * then uses the old full-book encode. DeepFilter opt-in stays on that
 * path too (`TTS_SECTION_MASTER=0` forces it).
 *
 * ffmpeg and ffprobe are spawned asynchronously. A synchronous child
 * froze the event loop, so the other sections' QA timers and Edge
 * sockets could not run until that master returned. ffmpeg in flight
 * is capped at the CPU count.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { isEmptyOrSilentAudio } from "@/lib/tts/audio-guard";
import {
  crossfadePcm16Mono,
  ffmpegConcatAvailable,
  resolveJoinFadeMs,
} from "@/lib/tts/crossfade-audio";
import { ensureJobScratchRoot } from "@/lib/tts/job-scratch";
import {
  MASTER_OUTPUT_MP3_BITRATE,
  MASTER_OUTPUT_SAMPLE_RATE,
  masterDenoiseWet,
  masterProfessionalAf,
  masterProfessionalLinearAf,
  masterProfessionalMeasureAf,
  parseLoudnormProbe,
} from "@/lib/tts/mastering";
import { createWavHeader, stripWavHeader } from "@/lib/tts/pcm-wav";
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

/** How many ffmpeg processes may run at once. About one per CPU. */
export function ffmpegSlotLimit(): number {
  return Math.max(1, availableParallelism());
}

type ChildResult = { stdout: string; stderr: string; status: number | null };

function createSlotGate(limit: number) {
  let active = 0;
  const waiters: Array<() => void> = [];
  return async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      if (active < limit) {
        active += 1;
        resolve();
        return;
      }
      waiters.push(() => {
        active += 1;
        resolve();
      });
    });
    try {
      return await fn();
    } finally {
      active -= 1;
      const next = waiters.shift();
      if (next) next();
    }
  };
}

export const withFfmpegSlot = createSlotGate(ffmpegSlotLimit());

function runChild(bin: string, args: string[], timeoutMs: number): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (err?: Error, result?: ChildResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(result!);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`${path.basename(bin)} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (err) => finish(err));
    child.on("close", (code) => finish(undefined, { stdout, stderr, status: code }));
  });
}

async function runFfmpeg(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 180_000
): Promise<void> {
  const result = await withFfmpegSlot(() =>
    runChild(ffmpegBin(env), ["-hide_banner", "-y", ...args], timeoutMs)
  );
  if (result.status !== 0) {
    throw new Error(`ffmpeg exit ${result.status}: ${(result.stderr || "").slice(-400)}`);
  }
}

/** Podcast chain + mono 128 kbps. Null when the pass fails or comes back silent. */
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
    const measured = await withFfmpegSlot(() =>
      runChild(
        ffmpegBin(env),
        ["-hide_banner", "-i", src, "-ac", "1", "-af", masterProfessionalMeasureAf(), "-f", "null", "-"],
        180_000
      )
    );
    const probe = parseLoudnormProbe(measured.stderr || "");
    await runFfmpeg(
      [
        "-i",
        src,
        "-ac",
        "1",
        "-af",
        probe ? masterProfessionalLinearAf(probe) : masterProfessionalAf(),
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

type Packet = { t: number; pos: number };

/**
 * Floor for the splice gate. Quiet audio has a tiny side p99, so a step
 * under this is still a join, not a click. Speech uses seven times its
 * own side p99, which sits above a consonant and under a broken frame.
 */
const COPY_JOIN_FLOOR = 900;

/**
 * The splice search reads about two seconds of the next section and the
 * last half-second of the previous one. Shorter than this, that search
 * has nowhere to land, and the old code aborted the whole book.
 */
const COPY_JOIN_MIN_SECONDS = 4;

/** Index in `haystack` of the first sample after `needle`. */
function indexAfter(needle: Buffer, haystack: Buffer): number {
  const n = needle.length / 2;
  const h = haystack.length / 2;
  const compare = Math.min(60, n);
  let bestAt = -1;
  let bestErr = Infinity;
  for (let s = 0; s <= h - n; s++) {
    let err = 0;
    for (let i = 0; i < compare; i += 4) {
      err += Math.abs(
        needle.readInt16LE((n - compare + i) * 2) -
          haystack.readInt16LE((s + n - compare + i) * 2)
      );
    }
    if (err < bestErr) {
      bestErr = err;
      bestAt = s + n;
    }
    if (err === 0) break;
  }
  if (bestAt < 0 || bestErr > compare * 30) {
    throw new Error("could not align a section tail");
  }
  return bestAt;
}

/**
 * Sample step at the packet splice, compared with the audio beside it.
 * A consonant elsewhere in the window is not a click. Speech at −16 LUFS
 * steps by several thousand on its own; an absolute cap tuned on a sine
 * rejects every real section.
 */
function rateSplice(pcm: Buffer, mixSamples: number): { jump: number; limit: number } {
  const samples = pcm.length / 2;
  const center = Math.max(2, Math.min(samples - 2, mixSamples));
  const radius = Math.max(8, Math.round(0.003 * SAMPLE_RATE));
  let jump = 0;
  const from = Math.max(1, center - radius);
  const to = Math.min(samples, center + radius);
  for (let i = from; i < to; i++) {
    const step = Math.abs(pcm.readInt16LE(i * 2) - pcm.readInt16LE((i - 1) * 2));
    if (step > jump) jump = step;
  }
  const side: number[] = [];
  const wing = Math.round(0.05 * SAMPLE_RATE);
  const collect = (start: number, end: number) => {
    for (let i = start; i < end; i++) {
      side.push(Math.abs(pcm.readInt16LE(i * 2) - pcm.readInt16LE((i - 1) * 2)));
    }
  };
  collect(Math.max(1, from - wing), from);
  collect(to, Math.min(samples, to + wing));
  side.sort((a, b) => a - b);
  const p99 = side[Math.floor(side.length * 0.99)] ?? 0;
  return { jump, limit: Math.max(COPY_JOIN_FLOOR, p99 * 7) };
}

function blendHead(head: Buffer, tail: Buffer, fadeSamples: number): Buffer {
  const out = Buffer.from(head);
  const n = Math.min(fadeSamples, out.length / 2, tail.length / 2);
  // `tail` starts at the first sample after the copied body. Blend that
  // continuation, not a later slice, or the body/mix boundary clicks.
  const tailStart = 0;
  for (let i = 0; i < n; i++) {
    const t = n <= 1 ? 1 : i / (n - 1);
    const gainOut = Math.cos(t * Math.PI * 0.5);
    const gainIn = Math.sin(t * Math.PI * 0.5);
    const a = tail.readInt16LE((tailStart + i) * 2);
    const b = out.readInt16LE(i * 2);
    const mixed = Math.round(a * gainOut + b * gainIn);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, mixed)), i * 2);
  }
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return out;
}

function mp3FrameLength(
  audio: Buffer,
  offset: number
): { length: number; samples: number; sampleRate: number } | null {
  if (offset + 4 > audio.length) return null;
  if (audio[offset] !== 0xff || (audio[offset + 1]! & 0xe0) !== 0xe0) return null;
  const version = (audio[offset + 1]! >> 3) & 0x3;
  const layer = (audio[offset + 1]! >> 1) & 0x3;
  if (version === 1 || layer === 0) return null;
  const b2 = audio[offset + 2]!;
  const bitrateIndex = (b2 >> 4) & 0xf;
  const sampleIndex = (b2 >> 2) & 0x3;
  const padding = (b2 >> 1) & 0x1;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) return null;
  const mpeg1 = version === 3;
  const layer1 = layer === 3;
  const rates = mpeg1
    ? layer1
      ? [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0]
      : layer === 2
        ? [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0]
        : [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
    : layer1
      ? [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
  const bitrate = rates[bitrateIndex] ?? 0;
  const base = [44100, 48000, 32000][sampleIndex] ?? 0;
  const sampleRate = mpeg1 ? base : version === 2 ? base / 2 : base / 4;
  if (!bitrate || !sampleRate) return null;
  const samples = layer1 ? 384 : mpeg1 || layer === 2 ? 1152 : 576;
  const length = layer1
    ? Math.floor((12 * bitrate * 1000) / sampleRate + padding) * 4
    : Math.floor((samples * bitrate * 1000) / (8 * sampleRate) + padding);
  if (length < 4 || offset + length > audio.length) return null;
  return { length, samples, sampleRate };
}

function secondFrameOffset(audio: Buffer): number | null {
  let offset = 0;
  if (audio.length >= 10 && audio.toString("ascii", 0, 3) === "ID3") {
    const size =
      ((audio[6]! & 0x7f) << 21) |
      ((audio[7]! & 0x7f) << 14) |
      ((audio[8]! & 0x7f) << 7) |
      (audio[9]! & 0x7f);
    offset = 10 + size + ((audio[5]! & 0x10) !== 0 ? 10 : 0);
  }
  const end = Math.min(audio.length - 4, offset + 8192);
  for (let i = offset; i < end; i++) {
    const frame = mp3FrameLength(audio, i);
    if (!frame) continue;
    if (mp3FrameLength(audio, i + frame.length)) return i + frame.length;
  }
  return null;
}

/**
 * Byte offset and start time of each MP3 frame. This replaces a per-section
 * `ffprobe -show_packets`: a long book was launching two probes per section
 * at once, and the 60s kill fired while the VM was stuck in that crowd.
 * Yields every few hundred frames so a multi-hour index does not freeze the
 * lease heartbeat.
 */
export async function indexMp3Packets(audio: Buffer): Promise<Packet[]> {
  let offset = 0;
  if (audio.length >= 10 && audio.toString("ascii", 0, 3) === "ID3") {
    const size =
      ((audio[6]! & 0x7f) << 21) |
      ((audio[7]! & 0x7f) << 14) |
      ((audio[8]! & 0x7f) << 7) |
      (audio[9]! & 0x7f);
    offset = Math.min(audio.length, 10 + size + ((audio[5]! & 0x10) !== 0 ? 10 : 0));
  }
  const packets: Packet[] = [];
  let time = 0;
  let steps = 0;
  while (offset + 4 <= audio.length && steps < audio.length) {
    steps += 1;
    const frame = mp3FrameLength(audio, offset);
    if (!frame) {
      offset += 1;
      continue;
    }
    const next = offset + frame.length;
    if (next < audio.length - 1 && !mp3FrameLength(audio, next)) {
      offset += 1;
      continue;
    }
    const body = audio.subarray(offset, next);
    const xing = packets.length === 0 && (body.includes(Buffer.from("Xing")) || body.includes(Buffer.from("Info")));
    if (!xing) {
      packets.push({ t: time, pos: offset });
      time += frame.samples / frame.sampleRate;
    }
    offset = next;
    if (packets.length % 512 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  if (packets.length < 4) throw new Error("no mp3 frames");
  return packets;
}

/** Seconds through the end of the last indexed frame. */
export function mp3IndexedDuration(packets: Packet[]): number {
  if (packets.length < 2) return packets[0]?.t ?? 0;
  const step = packets[1]!.t - packets[0]!.t;
  return packets[packets.length - 1]!.t + (step > 0 ? step : 0);
}

function slicePackets(
  audio: Buffer,
  list: Packet[],
  fromSec: number,
  toSec: number | null
): Buffer {
  let start = 0;
  if (fromSec > 0.001) {
    const packet = list.find((item) => item.t >= fromSec - 1e-4);
    if (!packet) return Buffer.alloc(0);
    start = Math.max(0, Math.min(audio.length, packet.pos));
  }
  let end = audio.length;
  if (toSec != null) {
    const packet = list.find((item) => item.t >= toSec - 1e-4);
    if (packet) end = Math.max(start, Math.min(audio.length, packet.pos));
  }
  return audio.subarray(start, end);
}

type CopyPiece = {
  audio: Buffer;
  packets: Packet[];
  duration: number;
  join: SectionJoinKind;
  file: string;
  /** Original section index (a folded piece keeps its first member's join). */
  index: number;
  /**
   * Where each folded original section's content starts inside this piece,
   * in seconds of piece time. A plain piece is one member at offset 0.
   */
  members: { index: number; offset: number }[];
};

/** Start of each folded section inside one PCM fold, mirroring crossfadePcm16Mono. */
function foldedMemberOffsets(
  pieces: CopyPiece[],
  crossfadeMs: number
): { offsets: number[]; total: number } {
  const offsets: number[] = [];
  let acc = 0;
  for (let i = 0; i < pieces.length; i++) {
    const duration = pieces[i]!.duration;
    if (i === 0) {
      offsets.push(0);
      acc = duration;
      continue;
    }
    const fade = resolveJoinFadeMs(pieces[i]!.join, crossfadeMs);
    const fadeSamples = Math.max(1, Math.round((SAMPLE_RATE * fade.ms) / 1000));
    const overlap =
      fade.ms > 0 &&
      Math.round(acc * SAMPLE_RATE) >= fadeSamples &&
      Math.round(duration * SAMPLE_RATE) >= fadeSamples
        ? fade.ms / 1000
        : 0;
    offsets.push(acc - overlap);
    acc = acc + duration - overlap;
  }
  return { offsets, total: acc };
}

function spreadPackets(span: Packet[], count: number): Packet[] {
  if (span.length === 0) return [];
  if (span.length <= count) return span.slice();
  const seeds: Packet[] = [];
  for (let s = 0; s < count; s++) {
    const packet = span[Math.round((s * (span.length - 1)) / (count - 1))]!;
    if (!seeds.some((seed) => seed.pos === packet.pos)) seeds.push(packet);
  }
  return seeds;
}

async function decodeMp3Pcm(
  run: Run,
  file: string,
  dest: string,
  timeoutMs: number,
  range?: { sseof?: number; t?: number }
): Promise<Buffer> {
  const args = ["-y"];
  if (range?.sseof != null && range.sseof > 0) {
    args.push("-sseof", (-range.sseof).toFixed(3));
  }
  args.push("-i", file);
  if (range?.t != null && range.t > 0) args.push("-t", range.t.toFixed(3));
  args.push("-ac", "1", "-ar", String(SAMPLE_RATE), "-c:a", "pcm_s16le", dest);
  await run(args, timeoutMs);
  return Buffer.from(stripWavHeader(await readFile(dest)));
}

async function encodePcmToMp3(
  run: Run,
  pcm: Buffer,
  dest: string,
  timeoutMs: number
): Promise<Buffer> {
  const wav = `${dest}.wav`;
  await writeFile(
    wav,
    Buffer.concat([createWavHeader(pcm.length, { sampleRate: SAMPLE_RATE }), pcm])
  );
  await run(
    [
      "-y",
      "-i",
      wav,
      "-ac",
      "1",
      "-ar",
      String(SAMPLE_RATE),
      "-c:a",
      "libmp3lame",
      "-b:a",
      MASTER_OUTPUT_MP3_BITRATE,
      "-reservoir",
      "0",
      "-write_xing",
      "0",
      dest,
    ],
    timeoutMs
  );
  return readFile(dest);
}

/** Crossfade a run of short sections into one PCM buffer. */
async function foldPiecePcm(
  pieces: CopyPiece[],
  crossfadeMs: number,
  run: Run,
  workDir: string,
  id: string,
  timeoutMs: number
): Promise<Buffer> {
  let acc: Buffer | null = null;
  for (let i = 0; i < pieces.length; i++) {
    const pcm = await decodeMp3Pcm(
      run,
      pieces[i]!.file,
      path.join(workDir, `short_dec_${id}_${i}.wav`),
      timeoutMs
    );
    if (pcm.length < 4) continue;
    if (!acc) {
      acc = pcm;
      continue;
    }
    const fade = resolveJoinFadeMs(pieces[i]!.join, crossfadeMs);
    acc = crossfadePcm16Mono(acc, pcm, SAMPLE_RATE, fade.ms, { clamp: fade.clamp });
  }
  if (!acc || acc.length < 4) throw new Error("section is too short to copy-join");
  return acc;
}

async function rateEncodedJoin(
  run: Run,
  mixBytes: Buffer,
  continuation: Buffer,
  workDir: string,
  id: string,
  timeoutMs: number
): Promise<{ jump: number; limit: number }> {
  const mixCut = path.join(workDir, `short_mix_${id}.mp3`);
  const rawPath = path.join(workDir, `short_raw_${id}.mp3`);
  const mixWav = path.join(workDir, `short_mix_${id}.wav`);
  const rawWav = path.join(workDir, `short_raw_${id}.wav`);
  await writeFile(mixCut, mixBytes);
  await writeFile(rawPath, Buffer.concat([mixBytes, continuation]));
  await run(
    [
      "-y",
      "-i",
      mixCut,
      "-i",
      rawPath,
      "-map",
      "0:a",
      "-ac",
      "1",
      "-ar",
      String(SAMPLE_RATE),
      "-c:a",
      "pcm_s16le",
      mixWav,
      "-map",
      "1:a",
      "-ac",
      "1",
      "-ar",
      String(SAMPLE_RATE),
      "-c:a",
      "pcm_s16le",
      rawWav,
    ],
    timeoutMs
  );
  const mixPcm = Buffer.from(stripWavHeader(await readFile(mixWav)));
  const pcm = Buffer.from(stripWavHeader(await readFile(rawWav)));
  return rateSplice(pcm, mixPcm.length / 2);
}

async function mixBytesAfterDelay(encoded: Buffer): Promise<Buffer> {
  const indexed = await indexMp3Packets(encoded);
  const cutPos = secondFrameOffset(encoded) ?? indexed[1]!.pos;
  return encoded.subarray(cutPos);
}

type StitchHit = { jump: number; limit: number; packet: Packet; piece: Buffer };

function preferHit(best: StitchHit | null, item: StitchHit | null): StitchHit | null {
  if (!item) return best;
  if (!best || item.jump / item.limit < best.jump / best.limit) return item;
  return best;
}

/**
 * Re-encode short sections with the crossfade into `next`, then packet-copy
 * the rest of `next`. The short audio stays at the front of the new file,
 * so the join from the previous section is unchanged.
 */
async function stitchShortsBefore(
  shorts: CopyPiece[],
  next: CopyPiece,
  crossfadeMs: number,
  run: Run,
  workDir: string,
  id: string,
  timeoutMs: number
): Promise<CopyPiece> {
  const fade = resolveJoinFadeMs(next.join, crossfadeMs);
  const shortPcm = await foldPiecePcm(shorts, crossfadeMs, run, workDir, id, timeoutMs);
  const headPcm = await decodeMp3Pcm(
    run,
    next.file,
    path.join(workDir, `short_head_${id}.wav`),
    timeoutMs,
    { t: 3.2 }
  );
  const minT = Math.max(0.2, fade.ms / 1000 + 0.06);
  const maxT = Math.min(2.4, Math.max(minT, next.duration - 0.08));
  const span = next.packets.filter((packet) => packet.t >= minT && packet.t <= maxT);
  if (span.length < 2) throw new Error("section is too short to copy-join");
  const seeds = spreadPackets(span, 8);
  let best: StitchHit | null = null;
  const scoreAt = async (packet: Packet): Promise<StitchHit | null> => {
    const n = Math.min(Math.round(packet.t * SAMPLE_RATE), Math.floor(headPcm.length / 2));
    const fadeSamples = Math.max(1, Math.round((SAMPLE_RATE * Math.max(fade.ms, 1)) / 1000));
    if (n < fadeSamples + 64) return null;
    const mixed = crossfadePcm16Mono(shortPcm, headPcm.subarray(0, n * 2), SAMPLE_RATE, fade.ms, {
      clamp: fade.clamp,
    });
    const encoded = await encodePcmToMp3(
      run,
      mixed,
      path.join(workDir, `short_enc_${id}_${Math.round(packet.t * 1000)}.mp3`),
      timeoutMs
    );
    const mixBytes = await mixBytesAfterDelay(encoded);
    const snippet = slicePackets(next.audio, next.packets, packet.t, packet.t + 0.35);
    if (snippet.length < 8 || mixBytes.length < 8) return null;
    const rated = await rateEncodedJoin(
      run,
      mixBytes,
      snippet,
      workDir,
      `${id}_${Math.round(packet.t * 1000)}`,
      timeoutMs
    );
    return { ...rated, packet, piece: mixBytes };
  };
  for (let wave = 0; wave < seeds.length; wave += 4) {
    if (best && best.jump * 2 < best.limit) break;
    const scored = await mapLimit(seeds.slice(wave, wave + 4), 4, scoreAt);
    for (const item of scored) best = preferHit(best, item);
  }
  if (best && !(best.jump * 2 < best.limit)) {
    const list = next.packets;
    const at = list.findIndex((packet) => packet.t === best!.packet.t);
    const extra = [list[at - 1], list[at + 1]].filter(
      (packet): packet is Packet => !!packet && packet.t >= minT && packet.t <= maxT
    );
    const scored = await mapLimit(extra, 2, scoreAt);
    for (const item of scored) best = preferHit(best, item);
  }
  if (!best || !(best.jump < best.limit)) {
    throw new Error(
      `short-section join would click (${best?.jump ?? "none"} vs ${best?.limit ?? "none"})`
    );
  }
  const rest = slicePackets(next.audio, next.packets, best.packet.t, null);
  const audio = Buffer.concat([best.piece, rest]);
  const file = path.join(workDir, `absorbed_${id}.mp3`);
  await writeFile(file, audio);
  const packets = await indexMp3Packets(audio);
  const fold = foldedMemberOffsets(shorts, crossfadeMs);
  const fadeSamples = Math.max(1, Math.round((SAMPLE_RATE * fade.ms) / 1000));
  const nextOverlap =
    fade.ms > 0 && Math.round(fold.total * SAMPLE_RATE) >= fadeSamples
      ? fade.ms / 1000
      : 0;
  return {
    audio,
    packets,
    duration: mp3IndexedDuration(packets),
    join: shorts[0]!.join,
    file,
    index: shorts[0]!.index,
    members: [
      ...shorts.map((piece, j) => ({ index: piece.index, offset: fold.offsets[j]! })),
      { index: next.index, offset: Math.max(0, fold.total - nextOverlap) },
    ],
  };
}

/**
 * Short sections after the last long one. Packet-copy that neighbor up to
 * the cut, and re-encode only its tail plus the short audio.
 */
async function stitchShortsAfter(
  prev: CopyPiece,
  shorts: CopyPiece[],
  crossfadeMs: number,
  run: Run,
  workDir: string,
  id: string,
  timeoutMs: number
): Promise<CopyPiece> {
  const fade = resolveJoinFadeMs(shorts[0]!.join, crossfadeMs);
  const shortPcm = await foldPiecePcm(shorts, crossfadeMs, run, workDir, `${id}t`, timeoutMs);
  const tailSeconds = Math.min(3.2, prev.duration);
  const tailPcm = await decodeMp3Pcm(
    run,
    prev.file,
    path.join(workDir, `short_tail_${id}.wav`),
    timeoutMs,
    { sseof: tailSeconds }
  );
  const tailSamples = Math.floor(tailPcm.length / 2);
  const tailOrigin = Math.max(0, prev.duration - tailSamples / SAMPLE_RATE);
  const prime = 0.12;
  const minT = Math.max(tailOrigin + prime + 0.08, prev.duration - 2.5);
  const maxT = prev.duration - Math.max(0.15, fade.ms / 1000 + 0.05);
  const span = prev.packets.filter((packet) => packet.t >= minT && packet.t <= maxT);
  if (span.length < 2) throw new Error("section is too short to copy-join");
  const seeds = spreadPackets(span, 8);
  let best: StitchHit | null = null;
  const scoreAt = async (packet: Packet): Promise<StitchHit | null> => {
    const startSample = Math.max(0, Math.round((packet.t - prime - tailOrigin) * SAMPLE_RATE));
    const fadeSamples = Math.max(1, Math.round((SAMPLE_RATE * Math.max(fade.ms, 1)) / 1000));
    if (tailSamples - startSample < fadeSamples + 64) return null;
    const mixed = crossfadePcm16Mono(
      tailPcm.subarray(startSample * 2),
      shortPcm,
      SAMPLE_RATE,
      fade.ms,
      { clamp: fade.clamp }
    );
    const encoded = await encodePcmToMp3(
      run,
      mixed,
      path.join(workDir, `short_enc_${id}_${Math.round(packet.t * 1000)}.mp3`),
      timeoutMs
    );
    const indexed = await indexMp3Packets(encoded);
    let startPos = indexed[Math.min(1, indexed.length - 1)]!.pos;
    for (const frame of indexed) {
      if (frame.t >= prime - 0.01) {
        startPos = frame.pos;
        break;
      }
    }
    const encodedTail = encoded.subarray(startPos);
    const lead = slicePackets(prev.audio, prev.packets, Math.max(0, packet.t - 0.3), packet.t);
    if (lead.length < 8 || encodedTail.length < 8) return null;
    const rated = await rateEncodedJoin(
      run,
      lead,
      encodedTail,
      workDir,
      `${id}_${Math.round(packet.t * 1000)}`,
      timeoutMs
    );
    return { ...rated, packet, piece: encodedTail };
  };
  for (let wave = 0; wave < seeds.length; wave += 4) {
    if (best && best.jump * 2 < best.limit) break;
    const scored = await mapLimit(seeds.slice(wave, wave + 4), 4, scoreAt);
    for (const item of scored) best = preferHit(best, item);
  }
  if (!best || !(best.jump < best.limit)) {
    throw new Error(
      `short-section join would click (${best?.jump ?? "none"} vs ${best?.limit ?? "none"})`
    );
  }
  const body = slicePackets(prev.audio, prev.packets, 0, best.packet.t);
  const audio = Buffer.concat([body, best.piece]);
  const file = path.join(workDir, `absorbed_${id}.mp3`);
  await writeFile(file, audio);
  const packets = await indexMp3Packets(audio);
  const fold = foldedMemberOffsets(shorts, crossfadeMs);
  const fadeSamples = Math.max(1, Math.round((SAMPLE_RATE * fade.ms) / 1000));
  const overlap =
    fade.ms > 0 && Math.round(fold.total * SAMPLE_RATE) >= fadeSamples
      ? fade.ms / 1000
      : 0;
  // The previous section was cut at the splice, which can sit well before
  // its old end. Time the absorbed heading from that cut, not the pre-cut duration.
  const shortsBase = Math.max(0, best.packet.t - overlap);
  return {
    audio,
    packets,
    duration: mp3IndexedDuration(packets),
    join: prev.join,
    file,
    index: prev.index,
    members: [
      ...prev.members,
      ...shorts.map((piece, j) => ({
        index: piece.index,
        offset: shortsBase + fold.offsets[j]!,
      })),
    ],
  };
}

function pieceIsShort(piece: CopyPiece): boolean {
  return piece.duration < COPY_JOIN_MIN_SECONDS || piece.packets.length < 4;
}

/** Fold every under-four-second section into a neighbor, then copy-join. */
async function promoteShortSections(
  pieces: CopyPiece[],
  crossfadeMs: number,
  run: Run,
  workDir: string,
  timeoutMs: number
): Promise<{ pieces: CopyPiece[]; absorbed: number }> {
  const out: CopyPiece[] = [];
  let absorbed = 0;
  let i = 0;
  let group = 0;
  while (i < pieces.length) {
    if (!pieceIsShort(pieces[i]!)) {
      out.push(pieces[i]!);
      i += 1;
      continue;
    }
    let j = i;
    while (j < pieces.length && pieceIsShort(pieces[j]!)) j += 1;
    const shorts = pieces.slice(i, j);
    absorbed += shorts.length;
    const id = `${group}`;
    group += 1;
    if (j < pieces.length) {
      out.push(
        await stitchShortsBefore(shorts, pieces[j]!, crossfadeMs, run, workDir, id, timeoutMs)
      );
      i = j + 1;
      continue;
    }
    if (out.length === 0) {
      const pcm = await foldPiecePcm(shorts, crossfadeMs, run, workDir, `all${id}`, timeoutMs);
      const file = path.join(workDir, `absorbed_all_${id}.mp3`);
      const audio = await encodePcmToMp3(run, pcm, file, timeoutMs);
      const packets = await indexMp3Packets(audio);
      const fold = foldedMemberOffsets(shorts, crossfadeMs);
      out.push({
        audio,
        packets,
        duration: mp3IndexedDuration(packets),
        join: shorts[0]!.join,
        file,
        index: shorts[0]!.index,
        members: shorts.map((piece, j) => ({ index: piece.index, offset: fold.offsets[j]! })),
      });
      break;
    }
    const prev = out.pop()!;
    out.push(await stitchShortsAfter(prev, shorts, crossfadeMs, run, workDir, id, timeoutMs));
    i = j;
  }
  return { pieces: out, absorbed };
}

/**
 * Packet-copy mastered sections. Each join re-encodes only the head of the
 * next section (the crossfade plus a short lead-in). A section under four
 * seconds is re-encoded into a neighbor first, so it does not abort the
 * copy. Throws when a splice would click, so the caller can encode the
 * book once instead.
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
}): Promise<{ sectionStarts: number[]; totalSeconds: number }> {
  const { timeoutMs, workDir } = opts;
  // Full-section loudnorm uses the CPU gate. These calls are a couple of
  // seconds each, and holding them to one-per-core turned a 38-section
  // finish into a few minutes. The pools below are the cap.
  const run = opts.run;
  let files = opts.files;
  let joins = opts.joins;
  if (files.length === 0) throw new Error("no mastered sections");

  const loaded = await mapLimit(files, 4, (file) => readFile(file));
  const indexedPieces: CopyPiece[] = [];
  for (let i = 0; i < loaded.length; i++) {
    let packets: Packet[] = [];
    let duration = 0;
    try {
      packets = await indexMp3Packets(loaded[i]!);
      duration = mp3IndexedDuration(packets);
    } catch {
      packets = [];
      duration = 0;
    }
    indexedPieces.push({
      audio: loaded[i]!,
      packets,
      duration,
      join: joins[i] ?? "paragraph",
      file: files[i]!,
      index: i,
      members: [{ index: i, offset: 0 }],
    });
  }
  if (indexedPieces.length === 1) {
    await run(["-y", "-i", files[0]!, "-c", "copy", opts.outPath], timeoutMs);
    return { sectionStarts: [0], totalSeconds: indexedPieces[0]!.duration };
  }
  const promoted = await promoteShortSections(
    indexedPieces,
    opts.crossfadeMs,
    run,
    workDir,
    timeoutMs
  );
  if (promoted.absorbed > 0) {
    console.log(
      `[section-master] re-encoded ${promoted.absorbed} short sections into the copy-join`
    );
  }
  files = promoted.pieces.map((piece) => piece.file);
  joins = promoted.pieces.map((piece) => piece.join);
  if (files.length === 1) {
    await run(["-y", "-i", files[0]!, "-c", "copy", opts.outPath], timeoutMs);
    const piece = promoted.pieces[0]!;
    const sectionStarts = new Array<number>(opts.files.length).fill(0);
    for (const member of piece.members) sectionStarts[member.index] = member.offset;
    return { sectionStarts, totalSeconds: piece.duration };
  }
  const sources = promoted.pieces.map((piece) => piece.audio);
  const packets = promoted.pieces.map((piece) => piece.packets);
  const durations = promoted.pieces.map((piece) => piece.duration);
  for (const duration of durations) {
    if (duration < COPY_JOIN_MIN_SECONDS) throw new Error("section is too short to copy-join");
  }

  const tailCut: Array<number | null> = files.map(() => null);
  const headCut: Array<Packet | null> = files.map(() => null);
  let worst = 0;

  type Prepared = {
    index: number;
    fadeSamples: number;
    tailPcm: Buffer;
    headPcm: Buffer;
  };

  const prepared = await mapLimit(
    files.slice(0, -1).map((_, index) => index),
    8,
    async (i): Promise<Prepared | null> => {
      const fade = resolveJoinFadeMs(joins[i + 1], opts.crossfadeMs);
      const fadeSamples = Math.max(1, Math.round((SAMPLE_RATE * fade.ms) / 1000));
      const fadeSec = fade.ms / 1000;
      // Leave the fade plus one frame. A longer cut drops words at the join.
      const keep = fadeSec + 0.03;
      let cut = packets[i]![0]!.t;
      for (const packet of packets[i]!) {
        if (durations[i]! - packet.t >= keep) cut = packet.t;
      }
      tailCut[i] = cut;
      if (fade.ms <= 0) {
        headCut[i + 1] = packets[i + 1]![0]!;
        return null;
      }
      const bodyA = path.join(workDir, `body_${i}.mp3`);
      await writeFile(bodyA, slicePackets(sources[i]!, packets[i]!, 0, cut));
      const tailWav = path.join(workDir, `tail_${i}.wav`);
      const endWav = path.join(workDir, `end_${i}.wav`);
      const headWav = path.join(workDir, `head_${i}.wav`);
      await run(
        [
          "-y",
          "-sseof",
          "-0.55",
          "-i",
          files[i]!,
          "-sseof",
          "-0.3",
          "-i",
          bodyA,
          "-t",
          "2.2",
          "-i",
          files[i + 1]!,
          "-map",
          "0:a",
          "-ac",
          "1",
          "-ar",
          String(SAMPLE_RATE),
          "-c:a",
          "pcm_s16le",
          tailWav,
          "-map",
          "1:a",
          "-ac",
          "1",
          "-ar",
          String(SAMPLE_RATE),
          "-c:a",
          "pcm_s16le",
          endWav,
          "-map",
          "2:a",
          "-ac",
          "1",
          "-ar",
          String(SAMPLE_RATE),
          "-c:a",
          "pcm_s16le",
          headWav,
        ],
        timeoutMs
      );
      const removed = Buffer.from(stripWavHeader(await readFile(tailWav)));
      const bodyEnd = Buffer.from(stripWavHeader(await readFile(endWav)));
      const after = indexAfter(bodyEnd, removed);
      const tailPcm = removed.subarray(after * 2);
      const headPcm = Buffer.from(stripWavHeader(await readFile(headWav)));
      return { index: i, fadeSamples, tailPcm, headPcm };
    }
  );

  const jobs = prepared.filter((item): item is Prepared => item !== null);
  const scoreOne = async (item: Prepared, packet: Packet) => {
    const n = Math.min(Math.round(packet.t * SAMPLE_RATE), item.headPcm.length / 2);
    if (n < item.fadeSamples + 64) {
      return { packet, jump: Number.POSITIVE_INFINITY, limit: 1, cutPos: 0 };
    }
    const id = `${item.index}_${Math.round(packet.t * 1000)}`;
    const mixed = blendHead(item.headPcm.subarray(0, n * 2), item.tailPcm, item.fadeSamples);
    const wav = path.join(workDir, `mix_${id}.wav`);
    const mp3 = path.join(workDir, `mix_${id}.mp3`);
    await writeFile(wav, Buffer.concat([createWavHeader(mixed.length, { sampleRate: SAMPLE_RATE }), mixed]));
    await run(
      [
        "-y",
        "-i",
        wav,
        "-ac",
        "1",
        "-ar",
        String(SAMPLE_RATE),
        "-c:a",
        "libmp3lame",
        "-b:a",
        MASTER_OUTPUT_MP3_BITRATE,
        "-reservoir",
        "0",
        "-write_xing",
        "0",
        mp3,
      ],
      timeoutMs
    );
    const encoded = await readFile(mp3);
    const indexed = await indexMp3Packets(encoded);
    const cutPos = secondFrameOffset(encoded) ?? indexed[1]!.pos;
    const mixBytes = encoded.subarray(cutPos);
    const snippet = slicePackets(
      sources[item.index + 1]!,
      packets[item.index + 1]!,
      packet.t,
      packet.t + 0.35
    );
    // The copied body is already aligned. Scoring that edge on a short
    // snippet hears the snippet's own encoder delay, so only the new
    // cut — mix into the next section — is measured here.
    const mixCut = path.join(workDir, `mixcut_${id}.mp3`);
    const rawPath = path.join(workDir, `raw_${id}.mp3`);
    await writeFile(mixCut, mixBytes);
    await writeFile(rawPath, Buffer.concat([mixBytes, snippet]));
    const mixWav = path.join(workDir, `mixcut_${id}.wav`);
    const rawWav = path.join(workDir, `raw_${id}.wav`);
    await run(
      [
        "-y",
        "-i",
        mixCut,
        "-i",
        rawPath,
        "-map",
        "0:a",
        "-ac",
        "1",
        "-ar",
        String(SAMPLE_RATE),
        "-c:a",
        "pcm_s16le",
        mixWav,
        "-map",
        "1:a",
        "-ac",
        "1",
        "-ar",
        String(SAMPLE_RATE),
        "-c:a",
        "pcm_s16le",
        rawWav,
      ],
      timeoutMs
    );
    const mixPcm = Buffer.from(stripWavHeader(await readFile(mixWav)));
    const pcm = Buffer.from(stripWavHeader(await readFile(rawWav)));
    const rated = rateSplice(pcm, mixPcm.length / 2);
    return {
      packet,
      jump: rated.jump,
      limit: rated.limit,
      cutPos,
    };
  };

  // A clean splice is one frame in a short window. Score a few at a time
  // and stop when one is comfortably under the limit. Holding every encode
  // to the section-master CPU cap made a 38-section finish take minutes.
  const seedCount = 12;
  const spans = new Map<number, Packet[]>();
  for (const item of jobs) {
    const fadeSec = item.fadeSamples / SAMPLE_RATE;
    const minT = Math.max(0.14, fadeSec + 0.03);
    const span = packets[item.index + 1]!.filter((p) => p.t >= minT && p.t <= 2.05);
    if (span.length < 2) throw new Error("section has no join frames");
    const seeds: Packet[] = [];
    for (let s = 0; s < seedCount; s++) {
      const packet = span[Math.round((s * (span.length - 1)) / (seedCount - 1))]!;
      if (!seeds.some((seed) => seed.t === packet.t)) seeds.push(packet);
    }
    spans.set(item.index, seeds);
  }

  const bestByJoin = new Map<
    number,
    { packet: Packet; jump: number; limit: number; cutPos: number }
  >();
  const scoredAt = new Set<string>();
  for (let wave = 0; wave < seedCount; wave += 4) {
    const tasks: Array<{ item: Prepared; packet: Packet }> = [];
    for (const item of jobs) {
      const best = bestByJoin.get(item.index);
      if (best && best.jump * 2 < best.limit) continue;
      const seeds = spans.get(item.index)!;
      for (const packet of seeds.slice(wave, wave + 4)) {
        const key = `${item.index}:${packet.t}`;
        if (scoredAt.has(key)) continue;
        scoredAt.add(key);
        tasks.push({ item, packet });
      }
    }
    if (tasks.length === 0) break;
    const seeded = await mapLimit(tasks, 8, (task) => scoreOne(task.item, task.packet));
    for (let n = 0; n < tasks.length; n++) {
      const task = tasks[n]!;
      const scored = seeded[n]!;
      const prev = bestByJoin.get(task.item.index);
      if (!prev || scored.jump / scored.limit < prev.jump / prev.limit) {
        bestByJoin.set(task.item.index, scored);
      }
    }
  }

  const refine: Array<{ item: Prepared; packet: Packet }> = [];
  for (const item of jobs) {
    const best = bestByJoin.get(item.index);
    if (!best || best.jump * 2 < best.limit) continue;
    const list = packets[item.index + 1]!;
    const at = list.findIndex((p) => p.t === best.packet.t);
    for (const packet of [list[at - 1], list[at + 1]]) {
      if (!packet || packet.t < 0.12 || packet.t > 2.2) continue;
      const key = `${item.index}:${packet.t}`;
      if (scoredAt.has(key)) continue;
      refine.push({ item, packet });
    }
  }
  const refined = await mapLimit(refine, 8, (task) => scoreOne(task.item, task.packet));
  for (let n = 0; n < refine.length; n++) {
    const task = refine[n]!;
    const scored = refined[n]!;
    const prev = bestByJoin.get(task.item.index)!;
    if (scored.jump / scored.limit < prev.jump / prev.limit) {
      bestByJoin.set(task.item.index, scored);
    }
  }

  for (const item of jobs) {
    const best = bestByJoin.get(item.index);
    if (!best || !(best.jump < best.limit)) {
      throw new Error(
        `join ${item.index} would click (${best?.jump ?? "none"} vs ${best?.limit ?? "none"})`
      );
    }
    if (best.jump > worst) worst = best.jump;
    headCut[item.index + 1] = best.packet;
  }

  const pieces: Buffer[] = [];
  const sectionStarts = new Array<number>(opts.files.length).fill(0);
  let clock = 0;
  for (let i = 0; i < files.length; i++) {
    const head = headCut[i];
    const tail = tailCut[i];
    const from = head && head.t > 0.001 ? head.t : 0;
    const to = tail == null ? null : head && head.t > 0.001 ? head.t + (tail - head.t) : tail;
    pieces.push(slicePackets(sources[i]!, packets[i]!, from, to));
    // The head of this piece (up to `from`) already played inside the
    // previous crossfade, so the piece's content zero sits `from` seconds
    // before its body bytes land.
    const contentStart = clock - from;
    for (const member of promoted.pieces[i]!.members) {
      sectionStarts[member.index] = Math.max(0, contentStart + member.offset);
    }
    clock += (tail == null ? durations[i]! : to!) - from;
    const next = headCut[i + 1];
    if (i < files.length - 1 && next && next.t > 0.001) {
      const mp3 = path.join(workDir, `mix_${i}_${Math.round(next.t * 1000)}.mp3`);
      const cutPos = bestByJoin.get(i)?.cutPos;
      const bytes = await readFile(mp3);
      pieces.push(bytes.subarray(cutPos ?? (await indexMp3Packets(bytes))[1]!.pos));
      clock += next.t;
    }
  }

  await writeFile(opts.outPath, Buffer.concat(pieces));
  console.log(
    `[section-master] copy-joined ${files.length} sections, worst splice step ${worst}`
  );
  return { sectionStarts, totalSeconds: clock };
}

