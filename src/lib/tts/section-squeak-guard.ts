/**
 * Worker-side wiring for the clone squeak guard (`squeak-guard.ts`).
 *
 * Per job: the clone's reference pitch profile (stored once next to the
 * clone's audio, keyed on its Fish reference + sample, so a re-clone gets a
 * fresh one). Per section: decode, detect, and notch the flagged milliseconds.
 * A whole section is not spoken again unless `TTS_SQUEAK_REGENERATE=1`.
 * The pitch-jump detector stays off until `TTS_SQUEAK_DETECTOR=pitch`;
 * thresholds for that detector wait on a labelled excerpt set.
 *
 * Runs only where sections are mastered (the VM worker). Any failure leaves
 * the take exactly as Fish returned it.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { downloadFile, uploadFile } from "@/lib/storage";
import { cloneRowIdFromCatalogId, isFishCloneCatalogId } from "@/lib/tts/fish-clone";
import { createWavHeader } from "@/lib/tts/pcm-wav";
import { shouldSectionMaster, withFfmpegSlot } from "@/lib/tts/section-master";
import {
  detectPitchSqueaks,
  detectSqueaks,
  estimatePitchProfile,
  repairSqueaks,
  squeakMinHz,
  squeakRate,
  type SqueakSpan,
  type VoicePitchProfile,
} from "@/lib/tts/squeak-guard";
import { getClonedVoiceForUser } from "@/lib/turso/cloned-voices";

const RATE = 44_100;
/** A take this much worse than usual gets one fresh take before repair. */
export const SQUEAK_REGENERATE_PER_MIN = 20;
const PROFILE_DIR = "voice-profiles";
const PROFILE_VERSION = "pitch-v1";

export function squeakGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.TTS_SQUEAK_GUARD === "0") return false;
  if (env.TTS_SQUEAK_GUARD === "1") return true;
  return shouldSectionMaster(env);
}

/**
 * Whole-section re-record. Off unless `TTS_SQUEAK_REGENERATE=1`.
 * The default notches the flagged milliseconds and leaves the rest of the take.
 */
export function squeakWholeSectionRetake(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TTS_SQUEAK_REGENERATE === "1";
}

/**
 * `spectral` is the detector that has been scoring sections.
 * `pitch` is the relative-F0 check. It stays off until labelled excerpts
 * pick its thresholds (`TTS_SQUEAK_DETECTOR=pitch`).
 */
export function squeakDetectorKind(env: NodeJS.ProcessEnv = process.env): "spectral" | "pitch" {
  return env.TTS_SQUEAK_DETECTOR === "pitch" ? "pitch" : "spectral";
}

function ffmpegBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.FFMPEG_PATH || env.TTS_FFMPEG_PATH || "ffmpeg";
}

/** Mono float PCM (44.1 kHz unless `rate` says otherwise) from any audio ffmpeg reads. */
export async function decodeMonoPcm(audio: Buffer, timeoutMs = 60_000, rate = RATE): Promise<Float32Array> {
  return withFfmpegSlot(
    () =>
      new Promise<Float32Array>((resolve, reject) => {
        const child = spawn(
          ffmpegBin(),
          ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-ac", "1", "-ar", String(rate), "-f", "f32le", "pipe:1"],
          { stdio: ["pipe", "pipe", "pipe"] }
        );
        const chunks: Buffer[] = [];
        let stderr = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
        child.stdout.on("data", (c: Buffer) => chunks.push(c));
        child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
        child.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0) return reject(new Error(`ffmpeg decode exit ${code}: ${stderr.slice(-300)}`));
          const buf = Buffer.concat(chunks);
          const aligned = new Float32Array(Math.floor(buf.length / 4));
          for (let i = 0; i < aligned.length; i++) aligned[i] = buf.readFloatLE(i * 4);
          resolve(aligned);
        });
        child.stdin.on("error", () => {});
        child.stdin.end(audio);
      })
  );
}

export function pcmToWav16(pcm: Float32Array, sampleRate = RATE): Buffer {
  const data = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]!));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return Buffer.concat([createWavHeader(data.length, { sampleRate, numChannels: 1, bitDepth: 16 }), data]);
}

const profileMemo = new Map<string, Promise<VoicePitchProfile | null>>();

/**
 * Pitch profile of a clone's reference sample. Read from storage when we
 * already measured it; otherwise measured now and stored for next time.
 */
export async function loadClonePitchProfile(
  userId: string,
  catalogVoiceId: string
): Promise<VoicePitchProfile | null> {
  const rowId = cloneRowIdFromCatalogId(catalogVoiceId);
  if (!rowId) return null;
  const row = await getClonedVoiceForUser(userId, rowId);
  if (!row?.sample_storage_path) return null;
  const key = createHash("sha256")
    .update(`${PROFILE_VERSION}|${row.fish_voice_id}|${row.sample_storage_path}`)
    .digest("hex")
    .slice(0, 24);
  const path = `${PROFILE_DIR}/${rowId}/${key}.json`;
  const memo = profileMemo.get(path);
  if (memo) return memo;
  const work = (async () => {
    try {
      const stored = JSON.parse((await downloadFile(path)).toString("utf8")) as VoicePitchProfile;
      if (Number.isFinite(stored?.medianHz) && Number.isFinite(stored?.p99Hz)) return stored;
    } catch {
      /* not measured yet */
    }
    const sample = await downloadFile(row.sample_storage_path!);
    const profile = estimatePitchProfile(await decodeMonoPcm(sample), RATE);
    if (profile) {
      await uploadFile(PROFILE_DIR, `${rowId}/${key}.json`, Buffer.from(JSON.stringify(profile)), "application/json").catch(
        () => {}
      );
    }
    return profile;
  })().catch((err) => {
    console.warn("[squeak-guard] reference profile failed:", err instanceof Error ? err.message : err);
    profileMemo.delete(path);
    return null;
  });
  profileMemo.set(path, work);
  return work;
}

export type SqueakGuardContext = {
  /** Tones above this are outside the reference speaker's range. */
  minHz: number | null;
  profile: VoicePitchProfile | null;
};

/** Per-job context, or null when the guard does not apply to this voice. */
export async function resolveSqueakGuard(opts: {
  userId: string;
  catalogVoiceId: string | null | undefined;
  providerId: string;
}): Promise<SqueakGuardContext | null> {
  if (!squeakGuardEnabled()) return null;
  if (opts.providerId !== "fish" || !isFishCloneCatalogId(opts.catalogVoiceId)) return null;
  const profile = await loadClonePitchProfile(opts.userId, opts.catalogVoiceId!).catch(() => null);
  return { minHz: profile ? squeakMinHz(profile) : null, profile };
}

export type GuardedTake = {
  audio: Buffer;
  contentType: string;
  /** The raw take that was kept (differs from the input after a regenerate). */
  rawAudio: Buffer;
  rawContentType: string;
  regenerated: boolean;
  found: number;
  repaired: number;
  durationHintSeconds?: number;
  ms: number;
};

type Take = { audio: Buffer; contentType: string; durationHintSeconds?: number };

async function scan(take: Take, ctx: SqueakGuardContext) {
  const pcm = await decodeMonoPcm(take.audio);
  await new Promise((r) => setImmediate(r));
  // No stored profile: three times this take's own median pitch.
  const minHz = ctx.minHz ?? (() => {
    const own = estimatePitchProfile(pcm, RATE);
    return own ? 3 * own.medianHz : null;
  })();
  const detector = squeakDetectorKind();
  const spans: SqueakSpan[] = !minHz
    ? []
    : detector === "pitch"
      ? detectPitchSqueaks(pcm, RATE, ctx.profile ?? { medianHz: minHz / 3, p99Hz: minHz / 1.5, p5Hz: minHz / 4, p95Hz: minHz / 2, stdSemitones: 2, voicedFrames: 0 })
      : detectSqueaks(pcm, RATE, minHz);
  return { pcm, spans, perMin: squeakRate(spans, pcm.length / RATE) };
}

/**
 * Detect, then notch. A whole-section retake runs only when
 * `TTS_SQUEAK_REGENERATE=1`. Never throws; on any failure the original
 * take comes back untouched.
 */
export async function guardSectionSqueaks(opts: {
  jobId: string;
  index: number;
  take: Take;
  ctx: SqueakGuardContext;
  regenerate: () => Promise<Take | null>;
}): Promise<GuardedTake> {
  const started = Date.now();
  const original: GuardedTake = {
    audio: opts.take.audio,
    contentType: opts.take.contentType,
    rawAudio: opts.take.audio,
    rawContentType: opts.take.contentType,
    regenerated: false,
    found: 0,
    repaired: 0,
    durationHintSeconds: opts.take.durationHintSeconds,
    ms: 0,
  };
  try {
    let take = opts.take;
    let result = await scan(take, opts.ctx);
    const found = result.spans.length;
    let regenerated = false;
    if (squeakWholeSectionRetake() && result.perMin > SQUEAK_REGENERATE_PER_MIN) {
      const again = await opts.regenerate().catch(() => null);
      if (again) {
        const second = await scan(again, opts.ctx);
        if (second.perMin < result.perMin) {
          take = again;
          result = second;
          regenerated = true;
        }
      }
    }
    const ms = Date.now() - started;
    console.log(
      `[Job ${opts.jobId}] section ${opts.index} squeak-guard detector=${squeakDetectorKind()} found=${found} perMin=${result.perMin.toFixed(2)} repaired=${result.spans.length} regenerated=${regenerated} ms=${ms}`
    );
    if (!result.spans.length) {
      return { ...original, audio: take.audio, contentType: take.contentType, rawAudio: take.audio, rawContentType: take.contentType, regenerated, found, durationHintSeconds: take.durationHintSeconds ?? original.durationHintSeconds, ms };
    }
    const fixed = repairSqueaks(result.pcm, RATE, result.spans);
    return {
      audio: pcmToWav16(fixed),
      contentType: "audio/wav",
      rawAudio: take.audio,
      rawContentType: take.contentType,
      regenerated,
      found,
      repaired: result.spans.length,
      durationHintSeconds: take.durationHintSeconds ?? original.durationHintSeconds,
      ms,
    };
  } catch (err) {
    console.warn(
      `[Job ${opts.jobId}] section ${opts.index} squeak-guard skipped:`,
      err instanceof Error ? err.message : err
    );
    return { ...original, ms: Date.now() - started };
  }
}
