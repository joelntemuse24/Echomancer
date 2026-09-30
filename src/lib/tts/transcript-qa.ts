/**
 * Compare a finished section with the words that were sent to the provider.
 *
 * Groq wins when `GROQ_API_KEY` is set. Otherwise the worker's
 * `OPENROUTER_API_KEY` sends the audio to `deepgram/nova-3`.
 * The speech-to-text endpoint ignores provider order and price-routes
 * `openai/whisper-large-v3-turbo` to DeepInfra, which runs a full section
 * at about realtime. Nova-3 is hosted only by Deepgram.
 * The wait is capped at 5 seconds. With neither key the check logs once
 * and keeps the audio. A transport, model, or budget error does the same.
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
/**
 * Single host, so OpenRouter cannot price-route it onto a realtime ASR.
 * Published end-to-end latency is well under the wait cap.
 */
const OPENROUTER_MODEL = "deepgram/nova-3";
/** A section check must not hold the book past this, even if the host is slow. */
export const QA_WALL_BUDGET_MS = 5_000;

function qaWaitMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.TTS_QA_BUDGET_MS);
  const chosen =
    Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : QA_WALL_BUDGET_MS;
  return Math.max(1, Math.min(QA_WALL_BUDGET_MS, chosen));
}

/** Stops waiting even when the request ignores its abort signal. */
async function withinBudget<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("qa budget")), ms);
  });
  try {
    return await Promise.race([work, budget]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type QaProviderName = "groq" | "openrouter";

const qaSkippedJobs = new Set<string>();

function openRouterKey(env: NodeJS.ProcessEnv): string {
  return (env.OPENROUTER_API_KEY || env.OPEN_ROUTER_API_KEY || "").trim();
}

/**
 * Groq when its key is set. OpenRouter otherwise.
 * Vitest plants a fake OpenRouter key; that path stays off unless
 * `TTS_SECTION_QA=1`.
 */
export function resolveQaProvider(
  env: NodeJS.ProcessEnv = process.env
): QaProviderName | null {
  if (env.GROQ_API_KEY?.trim()) return "groq";
  if (!openRouterKey(env)) return null;
  const vitest = Boolean(env.VITEST || process.env.VITEST);
  const optedIn = env.TTS_SECTION_QA === "1" || process.env.TTS_SECTION_QA === "1";
  if (vitest && !optedIn) return null;
  return "openrouter";
}

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
  apiKey: string,
  waitMs = QA_WALL_BUDGET_MS
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
    signal: AbortSignal.timeout(waitMs),
  });
  if (!res.ok) {
    throw new Error(`Groq transcript ${res.status}`);
  }
  const data = (await res.json()) as { text?: string };
  return typeof data.text === "string" ? data.text : "";
}

export async function transcribeWithOpenRouter(
  audio: Buffer,
  contentType: string,
  apiKey: string,
  env: NodeJS.ProcessEnv = process.env,
  waitMs = QA_WALL_BUDGET_MS
): Promise<string> {
  const base = (env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(
    /\/$/,
    ""
  );
  const res = await fetch(`${base}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": env.NEXT_PUBLIC_APP_URL || "https://echomancer.xyz",
      "X-Title": "Echomancer",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      language: "en",
      input_audio: {
        data: audio.toString("base64"),
        format: extOf(contentType),
      },
    }),
    signal: AbortSignal.timeout(waitMs),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter transcript ${res.status}`);
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
  action: string,
  via: QaProviderName,
  ms: number
): void {
  console.log(
    `[Job ${jobId}] section ${index} qa wer=${wer == null ? "-" : wer.toFixed(3)} flags=${
      flags.length ? flags.join(",") : "-"
    } action=${action} via=${via} ms=${Math.max(0, Math.round(ms))}`
  );
}

function logQaSkipped(jobId: string): void {
  if (qaSkippedJobs.has(jobId)) return;
  qaSkippedJobs.add(jobId);
  console.log(`[Job ${jobId}] qa skipped: no provider`);
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
  const env = opts.env ?? process.env;
  const provider = resolveQaProvider(env);
  if (!provider) {
    if (!env.GROQ_API_KEY?.trim() && !openRouterKey(env)) logQaSkipped(opts.jobId);
    return { ...opts.first, durationSec: null };
  }
  const apiKey =
    provider === "groq" ? env.GROQ_API_KEY!.trim() : openRouterKey(env);
  const waitMs = qaWaitMs(env);
  const started = Date.now();

  let fallback: { audio: Buffer; contentType: string; durationSec: number | null } = {
    ...opts.first,
    durationSec: null,
  };
  try {
    const judged = async (
      audio: Buffer,
      contentType: string
    ): Promise<Judged> => {
      const pending =
        provider === "groq"
          ? transcribeWithGroq(audio, contentType, apiKey, waitMs)
          : transcribeWithOpenRouter(audio, contentType, apiKey, env, waitMs);
      pending.catch(() => {});
      const transcript = await withinBudget(pending, waitMs);
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
      logQa(opts.jobId, opts.index, first.wer, first.flags, "keep", provider, Date.now() - started);
      return first;
    }

    const secondAudio = await opts.synthesize(opts.sourceText);
    if (!secondAudio) {
      logQa(opts.jobId, opts.index, first.wer, first.flags, "open", provider, Date.now() - started);
      return first;
    }
    const second = await judged(secondAudio.audio, secondAudio.contentType);
    fallback = second.score < first.score ? second : first;
    if (second.flags.length === 0) {
      noteSpeechRate(opts.rate, spokenCharCount(opts.sourceText), second.durationSec);
      logQa(opts.jobId, opts.index, second.wer, second.flags, "regen", provider, Date.now() - started);
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
    logQa(opts.jobId, opts.index, best.wer, best.flags, action, provider, Date.now() - started);
    return best;
  } catch (err) {
    console.warn(
      `[Job ${opts.jobId}] section ${opts.index} qa wer=- flags=- action=open via=${provider} ms=${Date.now() - started}`,
      err instanceof Error ? err.message : err
    );
    return fallback;
  }
}
