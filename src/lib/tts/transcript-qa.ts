/**
 * Compare a finished section with the words that were sent to the provider.
 *
 * Groq Whisper is optional. With no `GROQ_API_KEY` the check is skipped.
 * A transport or model error keeps the audio already synthesized.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { splitSentences } from "@/lib/tts/speakable-text";

export const QA_RUN_WORDS = 6;
export const QA_WER_MAX = 0.15;
export const QA_DURATION_SLOP = 0.25;
/** Seed until a clean section in this book has been measured. */
export const DEFAULT_CHARS_PER_SEC = 14;

const GROQ_TRANSCRIPT_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3-turbo";

export type QaFlag = "repeat" | "skip" | "wer" | "duration";

export type AlignmentReport = {
  wer: number;
  flags: QaFlag[];
  /** Word index in the source nearest the longest repeat or skip. */
  problemWord: number | null;
};

export type SpeechRate = { chars: number; seconds: number };

export function normalizeWords(text: string): string[] {
  return text
    .replace(/\[[^\]]*\]/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, " ")
    .replace(/'/g, "")
    .split(/\s+/)
    .filter(Boolean);
}

export function spokenCharCount(text: string): number {
  return text.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim().length;
}

function sameAt(needle: string[], haystack: string[], start: number): boolean {
  if (start < 0 || start + needle.length > haystack.length) return false;
  for (let i = 0; i < needle.length; i++) {
    if (needle[i] !== haystack[start + i]) return false;
  }
  return true;
}

/** Inserted run copies the words beside it, or a nearby span of the source. */
function duplicatesNeighbour(
  inserted: string[],
  ref: string[],
  anchor: number,
  hyp: string[],
  hypAt: number
): boolean {
  if (sameAt(inserted, hyp, hypAt - inserted.length)) return true;
  if (sameAt(inserted, hyp, hypAt + inserted.length)) return true;
  const from = Math.max(0, anchor - 40);
  const to = Math.min(ref.length, anchor + 40);
  for (let i = from; i + inserted.length <= to; i++) {
    if (sameAt(inserted, ref, i)) return true;
  }
  return false;
}

type Op = "eq" | "sub" | "ins" | "del";

function alignOps(ref: string[], hyp: string[]): { ops: Op[]; wer: number } {
  const n = ref.length;
  const m = hyp.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i]![0] = i;
  for (let j = 0; j <= m; j++) dp[0]![j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sub = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + sub
      );
    }
  }
  const ops: Op[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (
      i > 0 &&
      j > 0 &&
      dp[i]![j] === dp[i - 1]![j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1)
    ) {
      ops.push(ref[i - 1] === hyp[j - 1] ? "eq" : "sub");
      i -= 1;
      j -= 1;
      continue;
    }
    if (i > 0 && dp[i]![j] === dp[i - 1]![j]! + 1) {
      ops.push("del");
      i -= 1;
      continue;
    }
    ops.push("ins");
    j -= 1;
  }
  ops.reverse();
  const edits = ops.reduce((nEdits, op) => (op === "eq" ? nEdits : nEdits + 1), 0);
  const wer = n === 0 ? (m === 0 ? 0 : 1) : edits / n;
  return { ops, wer };
}

export function checkTranscriptAlignment(
  source: string,
  transcript: string
): AlignmentReport {
  const ref = normalizeWords(source);
  const hyp = normalizeWords(transcript);
  const { ops, wer } = alignOps(ref, hyp);
  const flags = new Set<QaFlag>();
  let problemWord: number | null = null;
  let problemRun = 0;
  let i = 0;
  let j = 0;
  for (let k = 0; k < ops.length; ) {
    const op = ops[k];
    if (op === "ins") {
      const hypAt = j;
      const anchor = i;
      let run = 0;
      while (k < ops.length && ops[k] === "ins") {
        run += 1;
        k += 1;
        j += 1;
      }
      if (
        run >= QA_RUN_WORDS &&
        duplicatesNeighbour(hyp.slice(hypAt, hypAt + run), ref, anchor, hyp, hypAt)
      ) {
        flags.add("repeat");
        if (run > problemRun) {
          problemRun = run;
          problemWord = anchor;
        }
      }
      continue;
    }
    if (op === "del") {
      const anchor = i;
      let run = 0;
      while (k < ops.length && ops[k] === "del") {
        run += 1;
        k += 1;
        i += 1;
      }
      if (run >= QA_RUN_WORDS) {
        flags.add("skip");
        if (run > problemRun) {
          problemRun = run;
          problemWord = anchor;
        }
      }
      continue;
    }
    k += 1;
    i += 1;
    j += 1;
  }
  if (wer > QA_WER_MAX) flags.add("wer");
  return { wer, flags: [...flags], problemWord };
}

export function durationDrift(
  chars: number,
  durationSec: number,
  charsPerSec: number
): boolean {
  if (chars < 40 || !(durationSec > 0) || !(charsPerSec > 0)) return false;
  const expected = chars / charsPerSec;
  return Math.abs(durationSec - expected) / expected > QA_DURATION_SLOP;
}

export function noteSpeechRate(rate: SpeechRate, chars: number, seconds: number | null): void {
  if (chars > 0 && seconds != null && seconds > 0) {
    rate.chars += chars;
    rate.seconds += seconds;
  }
}

export function charsPerSec(rate: SpeechRate): number {
  if (rate.seconds > 0 && rate.chars > 0) return rate.chars / rate.seconds;
  return DEFAULT_CHARS_PER_SEC;
}

/** Split on the sentence boundary closest to `problemWord`. */
export function splitNearestSentence(
  text: string,
  problemWord: number | null
): [string, string] | null {
  const sentences = splitSentences(text).map((s) => s.trim()).filter(Boolean);
  if (sentences.length < 2) return null;
  const counts = sentences.map((s) => normalizeWords(s).length);
  const total = counts.reduce((sum, n) => sum + n, 0);
  const target =
    problemWord == null ? Math.floor(total / 2) : Math.max(0, Math.min(total, problemWord));
  let cursor = 0;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < sentences.length - 1; i++) {
    cursor += counts[i] ?? 0;
    const dist = Math.abs(cursor - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  const left = sentences.slice(0, best + 1).join(" ").trim();
  const right = sentences.slice(best + 1).join(" ").trim();
  if (!left || !right) return null;
  return [left, right];
}

function errorScore(wer: number, flags: QaFlag[]): number {
  let score = wer;
  if (flags.includes("repeat")) score += 1;
  if (flags.includes("skip")) score += 1;
  if (flags.includes("duration")) score += 0.5;
  return score;
}

function extOf(contentType: string): string {
  if (contentType.includes("wav")) return "wav";
  if (contentType.includes("ogg")) return "ogg";
  return "mp3";
}

export async function probeAudioDurationSeconds(
  audio: Buffer,
  extension = "mp3"
): Promise<number | null> {
  const dir = await mkdtemp(path.join(tmpdir(), "ec-qa-"));
  try {
    const file = path.join(dir, `section.${extension}`);
    await writeFile(file, audio);
    const result = spawnSync(
      process.env.FFPROBE_PATH || "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      { encoding: "utf8" }
    );
    const n = Number((result.stdout || "").trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function transcribeWithGroq(
  audio: Buffer,
  contentType: string,
  apiKey: string
): Promise<string> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(audio)], { type: contentType || "audio/mpeg" }),
    `section.${extOf(contentType)}`
  );
  form.append("model", GROQ_MODEL);
  form.append("response_format", "json");
  form.append("language", "en");
  const res = await fetch(GROQ_TRANSCRIPT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) {
    throw new Error(`Groq transcript ${res.status}`);
  }
  const data = (await res.json()) as { text?: string };
  return typeof data.text === "string" ? data.text : "";
}

type Take = { audio: Buffer; contentType: string; durationSec: number | null };

type Judged = Take & {
  wer: number;
  flags: QaFlag[];
  problemWord: number | null;
  score: number;
};

function logQa(
  jobId: string,
  index: number,
  wer: number | null,
  flags: QaFlag[],
  action: string
): void {
  console.log(
    `[Job ${jobId}] section ${index} qa wer=${wer == null ? "-" : wer.toFixed(3)} flags=${
      flags.length ? flags.join(",") : "-"
    } action=${action}`
  );
}

/**
 * Transcribe, score, regenerate once on a flag, then split once.
 * Returns the audio with the lowest error. Throws are caught by the caller
 * only if this function itself throws; it does not.
 */
export async function settleSectionTake(opts: {
  jobId: string;
  index: number;
  sourceText: string;
  first: { audio: Buffer; contentType: string };
  synthesize: (text: string) => Promise<{ audio: Buffer; contentType: string } | null>;
  rate: SpeechRate;
  env?: NodeJS.ProcessEnv;
}): Promise<{ audio: Buffer; contentType: string; durationSec: number | null }> {
  const key = (opts.env ?? process.env).GROQ_API_KEY?.trim();
  if (!key) return { ...opts.first, durationSec: null };

  let fallback: { audio: Buffer; contentType: string; durationSec: number | null } = {
    ...opts.first,
    durationSec: null,
  };
  try {
    const judged = async (
      audio: Buffer,
      contentType: string
    ): Promise<Judged> => {
      const transcript = await transcribeWithGroq(audio, contentType, key);
      const aligned = checkTranscriptAlignment(opts.sourceText, transcript);
      const durationSec = await probeAudioDurationSeconds(audio, extOf(contentType));
      const flags = [...aligned.flags];
      const chars = spokenCharCount(opts.sourceText);
      if (durationDrift(chars, durationSec ?? 0, charsPerSec(opts.rate))) {
        flags.push("duration");
      }
      return {
        audio,
        contentType,
        durationSec,
        wer: aligned.wer,
        flags,
        problemWord: aligned.problemWord,
        score: errorScore(aligned.wer, flags),
      };
    };

    const first = await judged(opts.first.audio, opts.first.contentType);
    fallback = first;
    if (first.flags.length === 0) {
      noteSpeechRate(opts.rate, spokenCharCount(opts.sourceText), first.durationSec);
      logQa(opts.jobId, opts.index, first.wer, first.flags, "keep");
      return first;
    }

    const secondAudio = await opts.synthesize(opts.sourceText);
    if (!secondAudio) {
      logQa(opts.jobId, opts.index, first.wer, first.flags, "open");
      return first;
    }
    const second = await judged(secondAudio.audio, secondAudio.contentType);
    fallback = second.score < first.score ? second : first;
    if (second.flags.length === 0) {
      noteSpeechRate(opts.rate, spokenCharCount(opts.sourceText), second.durationSec);
      logQa(opts.jobId, opts.index, second.wer, second.flags, "regen");
      return second;
    }

    let best = first.score <= second.score ? first : second;
    let action = "regen";
    const parts = splitNearestSentence(
      opts.sourceText,
      second.problemWord ?? first.problemWord
    );
    if (parts) {
      const left = await opts.synthesize(parts[0]);
      const right = await opts.synthesize(parts[1]);
      if (left && right) {
        const joined = await judged(
          Buffer.concat([left.audio, right.audio]),
          left.contentType || right.contentType
        );
        fallback = joined.score < best.score ? joined : best;
        if (joined.score < best.score) {
          best = joined;
          action = "split";
        }
      }
    }
    if (best.flags.length === 0) {
      noteSpeechRate(opts.rate, spokenCharCount(opts.sourceText), best.durationSec);
    }
    logQa(opts.jobId, opts.index, best.wer, best.flags, action);
    return best;
  } catch (err) {
    console.warn(
      `[Job ${opts.jobId}] section ${opts.index} qa wer=- flags=- action=open`,
      err instanceof Error ? err.message : err
    );
    return fallback;
  }
}
