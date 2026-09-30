/**
 * Master one take-home section as soon as it is synthesized, then join
 * those MP3s at the end without running loudnorm over the book again.
 *
 * Each section gets the podcast chain (EQ, light de-esser, loudnorm to
 * −16 LUFS) and is stored as mono 96 kbps MP3. The loudnorm gain is
 * measured, then applied, so a short section does not sit quiet of −16.
 * Finish packet-copies those files and re-encodes only the crossfade
 * window (under two seconds). The cut is the frame whose splice step
 * matches the audio beside it. A consonant elsewhere in the window is
 * not a click. A bad frame is not used.
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

function ffprobeBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.FFPROBE_PATH || "ffprobe";
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

const withFfmpegSlot = createSlotGate(ffmpegSlotLimit());

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

async function probePackets(file: string, env: NodeJS.ProcessEnv): Promise<Packet[]> {
  const result = await runChild(
    ffprobeBin(env),
    [
      "-v",
      "error",
      "-select_streams",
      "a",
      "-show_packets",
      "-show_entries",
      "packet=pts_time,pos",
      "-of",
      "csv=p=0",
      file,
    ],
    60_000
  );
  const packets = (result.stdout || "")
    .trim()
    .split("\n")
    .map((line) => {
      const [t, pos] = line.split(",");
      return { t: Number(t), pos: Number(pos) };
    })
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.pos));
  if (packets.length < 4) throw new Error(`no mp3 frames in ${file}`);
  return packets;
}

async function probeDuration(file: string, env: NodeJS.ProcessEnv): Promise<number> {
  const result = await runChild(
    ffprobeBin(env),
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
    60_000
  );
  const n = Number((result.stdout || "").trim());
  if (!Number.isFinite(n) || n <= 0) throw new Error(`could not read duration of ${file}`);
  return n;
}

async function ffmpegToPcm(
  run: Run,
  before: string[],
  input: string,
  after: string[],
  dest: string,
  timeoutMs: number
): Promise<Buffer> {
  await run(
    ["-y", ...before, "-i", input, ...after, "-ac", "1", "-ar", String(SAMPLE_RATE), "-c:a", "pcm_s16le", dest],
    timeoutMs
  );
  return Buffer.from(stripWavHeader(await readFile(dest)));
}

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

/**
 * Packet-copy mastered sections. Each join re-encodes only the head of the
 * next section (the crossfade plus a short lead-in). Throws when a splice
 * would click, so the caller can encode the book once instead.
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
  const { files, timeoutMs, workDir } = opts;
  const env = opts.env ?? process.env;
  const run: Run = (args, childTimeoutMs) =>
    withFfmpegSlot(() => opts.run(args, childTimeoutMs));
  if (files.length === 0) throw new Error("no mastered sections");
  if (files.length === 1) {
    await run(["-y", "-i", files[0]!, "-c", "copy", opts.outPath], timeoutMs);
    return;
  }

  const packets = await Promise.all(files.map((file) => probePackets(file, env)));
  const durations = await Promise.all(files.map((file) => probeDuration(file, env)));
  for (const duration of durations) {
    if (duration < 4) throw new Error("section is too short to copy-join");
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
    4,
    async (i): Promise<Prepared | null> => {
      const fade = resolveJoinFadeMs(opts.joins[i + 1], opts.crossfadeMs);
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
      await run(
        ["-y", "-i", files[i]!, "-to", cut.toFixed(6), "-c", "copy", "-write_xing", "0", bodyA],
        timeoutMs
      );
      const removed = await ffmpegToPcm(
        run,
        ["-sseof", "-0.55"],
        files[i]!,
        [],
        path.join(workDir, `tail_${i}.wav`),
        timeoutMs
      );
      const bodyEnd = await ffmpegToPcm(
        run,
        ["-sseof", "-0.3"],
        bodyA,
        [],
        path.join(workDir, `end_${i}.wav`),
        timeoutMs
      );
      const after = indexAfter(bodyEnd, removed);
      const tailPcm = removed.subarray(after * 2);
      const headPcm = await ffmpegToPcm(
        run,
        ["-t", "2.2"],
        files[i + 1]!,
        [],
        path.join(workDir, `head_${i}.wav`),
        timeoutMs
      );
      return { index: i, fadeSamples, tailPcm, headPcm };
    }
  );

  const jobs = prepared.filter((item): item is Prepared => item !== null);
  const scoreOne = async (item: Prepared, packet: Packet) => {
    const n = Math.min(Math.round(packet.t * SAMPLE_RATE), item.headPcm.length / 2);
    if (n < item.fadeSamples + 64) {
      return { packet, jump: Number.POSITIVE_INFINITY, limit: 1 };
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
    const mixPackets = await probePackets(mp3, env);
    const snippetB = path.join(workDir, `snip_${id}.mp3`);
    await run(
      ["-y", "-ss", packet.t.toFixed(6), "-t", "0.35", "-i", files[item.index + 1]!, "-c", "copy", "-write_xing", "0", snippetB],
      timeoutMs
    );
    // The copied body is already aligned. Scoring that edge on a short
    // snippet hears the snippet's own encoder delay, so only the new
    // cut — mix into the next section — is measured here.
    const mixBytes = (await readFile(mp3)).subarray(mixPackets[1]!.pos);
    const mixCut = path.join(workDir, `mixcut_${id}.mp3`);
    await writeFile(mixCut, mixBytes);
    const mixPcm = await ffmpegToPcm(
      run,
      [],
      mixCut,
      [],
      path.join(workDir, `mixcut_${id}.wav`),
      timeoutMs
    );
    const raw = Buffer.concat([mixBytes, await readFile(snippetB)]);
    const rawPath = path.join(workDir, `raw_${id}.mp3`);
    await writeFile(rawPath, raw);
    const pcm = await ffmpegToPcm(run, [], rawPath, [], path.join(workDir, `raw_${id}.wav`), timeoutMs);
    const rated = rateSplice(pcm, mixPcm.length / 2);
    return { packet, jump: rated.jump, limit: rated.limit };
  };

  // A clean splice is one MP3-frame parity in a short window. That window
  // moves from join to join, so a few frames spread over the first two
  // seconds are scored and the quietest one is kept.
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

  const bestByJoin = new Map<number, { packet: Packet; jump: number; limit: number }>();
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
  for (let i = 0; i < files.length; i++) {
    const body = path.join(workDir, `span_${i}.mp3`);
    const args = ["-y"];
    const head = headCut[i];
    const tail = tailCut[i];
    if (head && head.t > 0.001) {
      args.push("-ss", head.t.toFixed(6));
      if (tail != null) args.push("-t", (tail - head.t).toFixed(6));
    }
    args.push("-i", files[i]!);
    if (tail != null && !(head && head.t > 0.001)) args.push("-to", tail.toFixed(6));
    args.push("-c", "copy", "-write_xing", "0", body);
    await run(args, timeoutMs);
    pieces.push(await readFile(body));
    const next = headCut[i + 1];
    if (i < files.length - 1 && next && next.t > 0.001) {
      const mp3 = path.join(workDir, `mix_${i}_${Math.round(next.t * 1000)}.mp3`);
      const mixPackets = await probePackets(mp3, env);
      pieces.push((await readFile(mp3)).subarray(mixPackets[1]!.pos));
    }
  }

  const rawPath = path.join(workDir, "copy-raw.mp3");
  await writeFile(rawPath, Buffer.concat(pieces));
  await run(["-y", "-i", rawPath, "-c", "copy", opts.outPath], timeoutMs);
  console.log(
    `[section-master] copy-joined ${files.length} sections, worst splice step ${worst}`
  );
}

