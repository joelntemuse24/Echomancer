/**
 * Soft joins for Whole-book concat. Live Listen streams never use this.
 *
 * WAV / raw PCM: equal-power (quarter-sine) crossfade in-process, after
 * a short edge-silence trim so provider padding does not become a gap.
 * MP3 / Ogg joins are decoded to PCM and use the same fade. Byte-gluing
 * compressed frames is not a success path.
 */

import { accessSync, constants } from "node:fs";
import type { SectionJoinKind } from "@/lib/tts/types";

export const CROSSFADE_MS_DEFAULT = 120;
export const CROSSFADE_MS_MIN = 80;
export const CROSSFADE_MS_MAX = 150;
/**
 * Silence kept at a sentence / mid-paragraph join, per edge.
 * Two edges of this length, minus the 12 ms micro fade, land near the
 * in-section sentence pause (~410–440 ms). The old 40 ms keep trimmed a
 * ~450 ms pause down to about 115 ms.
 */
export const JOIN_SILENCE_KEEP_MS = 225;
/**
 * Paragraph and chapter joins keep a longer edge. The fade is then
 * limited to the silence that remains, so a 140 ms paragraph fade cannot
 * run into the next word.
 */
export const JOIN_PARAGRAPH_SILENCE_KEEP_MS = 300;
/**
 * Click-guard for a mid-paragraph cut. Short enough that split words
 * do not smear, long enough that a non-zero boundary does not tick.
 * Bypasses the 80 ms floor used for paragraph / chapter fades.
 */
export const MICRO_JOIN_FADE_MS = 12;
/** ~−45 dBFS. Only true padding, not the tail of a quiet word. */
export const JOIN_SILENCE_THRESHOLD = 180;
/** Cap so a real chapter pause inside a section is not eaten. */
export const JOIN_SILENCE_MAX_TRIM_MS = 320;

export function joinSilenceKeepMs(kind: SectionJoinKind | undefined): number {
  if (kind === "paragraph" || kind === "chapter") return JOIN_PARAGRAPH_SILENCE_KEEP_MS;
  return JOIN_SILENCE_KEEP_MS;
}

/**
 * Keep for each edge of section `index`. The first lead and the last tail
 * are not a join, so they use the sentence keep. Every other edge uses
 * the join at that boundary.
 */
export function sectionEdgeKeepMs(
  index: number,
  count: number,
  joins: Array<SectionJoinKind | undefined>
): { keepLeadMs: number; keepTailMs: number } {
  return {
    keepLeadMs: index === 0 ? JOIN_SILENCE_KEEP_MS : joinSilenceKeepMs(joins[index]),
    keepTailMs:
      index === count - 1 ? JOIN_SILENCE_KEEP_MS : joinSilenceKeepMs(joins[index + 1]),
  };
}
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

export type EdgeSilenceTrim = { trimLead: number; trimTail: number };

/**
 * How many samples to drop from each edge. `lead` is PCM from the start
 * of the section and `tail` is PCM from the end (each at most the scan
 * window). A fully silent span that the two windows cover is left alone.
 */
export type EdgeSilenceOptions = {
  threshold?: number;
  keepMs?: number;
  keepLeadMs?: number;
  keepTailMs?: number;
  maxTrimMs?: number;
  /** False leaves the start of the buffer alone. Default true. */
  trimLead?: boolean;
  /** False leaves the end of the buffer alone. Default true. */
  trimTail?: boolean;
};

function keepSamples(sampleRate: number, ms: number): number {
  return Math.max(0, Math.round((sampleRate * ms) / 1000));
}

export function leadingSilenceSamples(
  pcm: Buffer,
  threshold = JOIN_SILENCE_THRESHOLD
): number {
  const samples = Math.floor(pcm.length / BYTES_PER_PCM16_SAMPLE);
  let n = 0;
  for (let i = 0; i < samples; i++) {
    if (Math.abs(pcm.readInt16LE(i * BYTES_PER_PCM16_SAMPLE)) > threshold) break;
    n++;
  }
  return n;
}

export function trailingSilenceSamples(
  pcm: Buffer,
  threshold = JOIN_SILENCE_THRESHOLD
): number {
  const samples = Math.floor(pcm.length / BYTES_PER_PCM16_SAMPLE);
  let n = 0;
  for (let i = samples - 1; i >= 0; i--) {
    if (Math.abs(pcm.readInt16LE(i * BYTES_PER_PCM16_SAMPLE)) > threshold) break;
    n++;
  }
  return n;
}

/**
 * Paragraph / chapter fades stay inside the silence on both edges.
 * Two voiced edges keep the requested fade: that is the click guard,
 * and there is no pause to protect. A pause on only one side fades by
 * nothing, so the fade cannot eat the next word.
 */
export function fadeMsThatSparesSpeech(
  requestedMs: number,
  sampleRate: number,
  left: Buffer,
  right: Buffer,
  threshold = JOIN_SILENCE_THRESHOLD
): number {
  if (!(requestedMs > 0) || sampleRate <= 0) return 0;
  const leftMs = (trailingSilenceSamples(left, threshold) * 1000) / sampleRate;
  const rightMs = (leadingSilenceSamples(right, threshold) * 1000) / sampleRate;
  // No silence on either edge: this is a hard cut, and the requested fade
  // is what keeps it from clicking. A pause that is shorter than the fade
  // shrinks the fade so it stays inside the silence.
  if (leftMs < 1 && rightMs < 1) return requestedMs;
  return Math.min(requestedMs, Math.max(0, Math.min(leftMs, rightMs)));
}

export function planEdgeSilenceTrim(
  lead: Buffer,
  tail: Buffer,
  totalSamples: number,
  sampleRate: number,
  opts?: EdgeSilenceOptions
): EdgeSilenceTrim {
  const none = { trimLead: 0, trimTail: 0 };
  if (sampleRate <= 0 || totalSamples < 2) return none;
  const threshold = opts?.threshold ?? JOIN_SILENCE_THRESHOLD;
  const keepLead = keepSamples(
    sampleRate,
    opts?.keepLeadMs ?? opts?.keepMs ?? JOIN_SILENCE_KEEP_MS
  );
  const keepTail = keepSamples(
    sampleRate,
    opts?.keepTailMs ?? opts?.keepMs ?? JOIN_SILENCE_KEEP_MS
  );
  const maxTrim = Math.max(
    0,
    Math.round(
      (sampleRate * (opts?.maxTrimMs ?? JOIN_SILENCE_MAX_TRIM_MS)) / 1000
    )
  );
  const guard = Math.max(keepLead, keepTail);
  if (maxTrim <= 0 || totalSamples <= guard * 2) return none;

  const leadSamples = Math.min(totalSamples, Math.floor(lead.length / BYTES_PER_PCM16_SAMPLE));
  let leadSilent = 0;
  const leadLimit = Math.min(leadSamples, maxTrim + keepLead);
  for (let i = 0; i < leadLimit; i++) {
    if (Math.abs(lead.readInt16LE(i * BYTES_PER_PCM16_SAMPLE)) > threshold) break;
    leadSilent++;
  }
  const tailSamples = Math.floor(tail.length / BYTES_PER_PCM16_SAMPLE);
  let tailSilent = 0;
  const tailLimit = Math.min(totalSamples - leadSilent, maxTrim + keepTail, tailSamples);
  for (let i = 0; i < tailLimit; i++) {
    const idx = tailSamples - 1 - i;
    if (Math.abs(tail.readInt16LE(idx * BYTES_PER_PCM16_SAMPLE)) > threshold) break;
    tailSilent++;
  }
  if (leadSilent + tailSilent >= totalSamples) return none;

  let trimLead = Math.min(maxTrim, Math.max(0, leadSilent - keepLead));
  let trimTail = Math.min(maxTrim, Math.max(0, tailSilent - keepTail));
  if (opts?.trimLead === false) trimLead = 0;
  if (opts?.trimTail === false) trimTail = 0;
  if (trimLead + trimTail >= totalSamples - 1) return none;
  return { trimLead, trimTail };
}

/**
 * Drop provider padding at the edges of one PCM section. Scans only the
 * trim window, so a long book is not walked sample-by-sample. A buffer
 * that is silent all the way through is left alone.
 */
export function trimPcm16EdgeSilence(
  pcm: Buffer,
  sampleRate: number,
  opts?: EdgeSilenceOptions
): Buffer {
  const samples = sampleCount(pcm);
  const { trimLead, trimTail } = planEdgeSilenceTrim(pcm, pcm, samples, sampleRate, opts);
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

/**
 * Crossfade `right` onto `left`. Paragraph and chapter fades shrink to
 * the silence on both edges. The caller has already trimmed.
 */
export function joinTrimmedPcm(
  left: Buffer,
  right: Buffer,
  sampleRate: number,
  joinKind: SectionJoinKind | undefined,
  defaultFadeMs: number
): Buffer {
  const fade = resolveJoinFadeMs(joinKind, defaultFadeMs);
  const ms = fade.clamp
    ? fadeMsThatSparesSpeech(fade.ms, sampleRate, left, right)
    : fade.ms;
  if (!(ms > 0)) return Buffer.concat([left, right]);
  return crossfadePcm16Mono(left, right, sampleRate, ms, { clamp: false });
}

export function concatPcm16MonoWithCrossfade(
  parts: Buffer[],
  sampleRate: number,
  durationMs = CROSSFADE_MS_DEFAULT,
  joins?: Array<SectionJoinKind | undefined>
): Buffer {
  if (parts.length === 0) return Buffer.alloc(0);
  if (parts.length === 1) return parts[0]!;
  const ms = clampCrossfadeMs(durationMs);
  if (ms <= 0) return Buffer.concat(parts);

  const prepared = parts.map((part, index) =>
    trimPcm16EdgeSilence(part, sampleRate, sectionEdgeKeepMs(index, parts.length, joins ?? []))
  );
  let acc = prepared[0]!;
  for (let i = 1; i < prepared.length; i++) {
    acc = joinTrimmedPcm(acc, prepared[i]!, sampleRate, joins?.[i], ms);
  }
  return acc;
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
