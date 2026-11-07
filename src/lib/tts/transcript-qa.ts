/**
 * Compare a finished section with the words that were sent to the provider.
 *
 * The worker's `OPENROUTER_API_KEY` sends the audio to `deepgram/nova-3`.
 * The speech-to-text endpoint ignores provider order and price-routes
 * `openai/whisper-large-v3-turbo` to DeepInfra, which runs a full section
 * at about realtime. Nova-3 is hosted only by Deepgram.
 * The whole check, including the duration read, stays inside 5 seconds.
 * `ms=` is that wait. The transcript request runs on a worker thread with
 * `AbortSignal.timeout`, so the 5s cap is wall-clock even when this
 * thread is busy. `TTS_SECTION_QA_ENABLED=0` skips the check even when a
 * key is set. Duration is taken from the MP3 or WAV bytes in process.
 * With no key, or with the switch off, the check logs once and
 * keeps the audio. A transport, model, or budget error does the same.
 */
import { Worker } from "node:worker_threads";
import { splitSentences } from "@/lib/tts/speakable-text";
import { assembleSectionTakes } from "@/lib/tts/section-master";
import { CpuSaturatedError } from "@/lib/cpu/errors";
import { insideCpuTask, tryCpuSlot } from "@/lib/cpu/task-slot";
import {
  qaTranscriptsDisabled,
  resolveSttProvider,
  type SttProviderName,
} from "@/lib/tts/stt/selector";
import { localWhisperAvailable, transcribeWithLocalWhisper } from "@/lib/tts/stt/local-whisper";

export const QA_REGENERATION_ATTEMPTS = 3;
export const QA_ASSEMBLY_BUDGET_MS = 30_000;

export function qaRegenerationBudgetMs(attemptMs: number): number {
  return QA_REGENERATION_ATTEMPTS * attemptMs + 4 * QA_WALL_BUDGET_MS + QA_ASSEMBLY_BUDGET_MS;
}

export const QA_RUN_WORDS = 6;
export const QA_WER_MAX = 0.15;
export const QA_DURATION_SLOP = 0.25;
/** Seed until a clean section in this book has been measured. */
export const DEFAULT_CHARS_PER_SEC = 14;

/**
 * Single host, so OpenRouter cannot price-route it onto a realtime ASR.
 * Published end-to-end latency is well under the wait cap.
 */
const OPENROUTER_MODEL = "deepgram/nova-3";
/** A section check must not hold the book past this, even if the host is slow. */
export const QA_WALL_BUDGET_MS = 5_000;

/**
 * Local Whisper runs on this CPU, so its cap tracks the audio length instead
 * of being a flat 5s: a 227s section legitimately takes ~6s of Wall clock.
 */
export const LOCAL_WHISPER_WAIT_FLOOR_MS = 10_000;
export const LOCAL_WHISPER_WAIT_CEILING_MS = 180_000;
/** Assumed audio length when the container's duration cannot be read. */
const MAX_LOCAL_AUDIO_SEC = 400;

function qaWaitMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.TTS_QA_BUDGET_MS);
  const chosen =
    Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : QA_WALL_BUDGET_MS;
  return Math.max(1, Math.min(QA_WALL_BUDGET_MS, chosen));
}

/**
 * The worker's event loop is not this thread's. AbortSignal.timeout there
 * cancels the socket at 5s even while the main thread is inside a
 * synchronous child or a long stretch of JS.
 */
const QA_FETCH_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { url, apiKey, audio, format, waitMs, referer, model } = workerData;
const signal = AbortSignal.timeout(waitMs);
const bytes = Buffer.from(audio);
const init = {
  method: "POST",
  headers: {
    Authorization: "Bearer " + apiKey,
    "Content-Type": "application/json",
    "HTTP-Referer": referer || "https://echomancer.xyz",
    "X-Title": "Echomancer",
  },
  body: JSON.stringify({
    model,
    language: "en",
    input_audio: { data: bytes.toString("base64"), format },
  }),
  signal,
};
fetch(url, init)
  .then(async (res) => {
    const raw = await res.text();
    if (!res.ok) {
      parentPort.postMessage({ ok: false, error: "transcript " + res.status });
      return;
    }
    let text = "";
    try {
      const parsed = JSON.parse(raw);
      text = typeof parsed.text === "string" ? parsed.text : "";
    } catch {
      text = "";
    }
    parentPort.postMessage({ ok: true, text });
  })
  .catch((err) => {
    const name = err && err.name;
    const aborted = name === "TimeoutError" || name === "AbortError";
    parentPort.postMessage({
      ok: false,
      error: aborted ? "qa budget" : String((err && err.message) || err),
    });
  });
`;

function fetchTranscript(opts: {
  url: string;
  apiKey: string;
  audio: Buffer;
  format: string;
  waitMs: number;
  referer?: string;
  model: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(QA_FETCH_WORKER, {
      eval: true,
      workerData: {
        url: opts.url,
        apiKey: opts.apiKey,
        audio: Buffer.from(opts.audio),
        format: opts.format,
        waitMs: opts.waitMs,
        referer: opts.referer || "",
        model: opts.model,
      },
    });
    const finish = (err?: Error, text?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(backup);
      worker.terminate().catch(() => {});
      if (err) reject(err);
      else resolve(text ?? "");
    };
    const backup = setTimeout(() => finish(new Error("qa budget")), opts.waitMs + 500);
    worker.once("message", (msg: { ok?: boolean; text?: string; error?: string }) => {
      if (msg?.ok) finish(undefined, typeof msg.text === "string" ? msg.text : "");
      else finish(new Error(msg?.error || "qa budget"));
    });
    worker.once("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
  });
}

/**
 * @deprecated Kept for the log line and for callers that still name a
 * provider. `"local"` is self-hosted Whisper; `"deepgram"` is Nova-3.
 */
export type QaProviderName = SttProviderName;

const qaSkippedJobs = new Set<string>();

function openRouterKey(env: NodeJS.ProcessEnv): string {
  return (env.OPENROUTER_API_KEY || env.OPEN_ROUTER_API_KEY || "").trim();
}

/** `TTS_SECTION_QA_ENABLED=0` (or false/off) skips QA even when a key is set. */
export function qaExplicitlyDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return qaTranscriptsDisabled(env);
}

/**
 * Which transcriber answers for this process.
 *
 * Default is `local` (self-hosted Whisper) — no key, no per-minute bill. Set
 * `TTS_QA_PROVIDER=deepgram` for the hosted Nova-3 path, or `off` to skip QA.
 * `TTS_SECTION_QA_ENABLED=0` still forces `off`.
 *
 * Vitest plants a fake OpenRouter key, so the network path needs
 * `TTS_SECTION_QA=1` to opt in. That test-only variable is not a production
 * switch — do not document it as one.
 */
export function resolveQaProvider(
  env: NodeJS.ProcessEnv = process.env
): QaProviderName | null {
  const provider = resolveSttProvider(env);
  if (!provider) return null;
  if (provider === "deepgram") {
    if (!openRouterKey(env)) return null;
    const vitest = Boolean(env.VITEST || process.env.VITEST);
    const optedIn = env.TTS_SECTION_QA === "1" || process.env.TTS_SECTION_QA === "1";
    if (vitest && !optedIn) return null;
    return "deepgram";
  }
  if (!localWhisperAvailable(env)) return null;
  return "local";
}

/**
 * Local Whisper budget. Measured RTF is ~0.03 wall on 4 vCPU, but the worker
 * may be running a master or an extract child at the same time, so allow a
 * wide multiplier and a floor. This is a wall-clock cap on one process, not
 * the section's overall deadline.
 */
export function localWhisperWaitMs(
  audioSec: number | null,
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = Number(env.TTS_QA_WHISPER_BUDGET_MS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  const seconds = audioSec && audioSec > 0 ? audioSec : MAX_LOCAL_AUDIO_SEC;
  return Math.min(
    LOCAL_WHISPER_WAIT_CEILING_MS,
    Math.max(LOCAL_WHISPER_WAIT_FLOOR_MS, Math.round(seconds * 1_000 * 0.4))
  );
}

export async function transcribeLocally(
  audio: Buffer,
  env: NodeJS.ProcessEnv,
  remainingMs: number
): Promise<string> {
  const audioSec = audioDurationSeconds(audio);
  const budget = Math.max(1_000, Math.min(localWhisperWaitMs(audioSec, env), remainingMs));
  const result = await transcribeWithLocalWhisper(audio, env, budget);
  if (!result.ok) throw new Error(result.error);
  return result.text;
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
  if (contentType.includes("webm")) return "webm";
  return "mp3";
}

/** Bound so a slow transcript does not hold the clone. */
const CLONE_TRANSCRIPT_WAIT_MS = 3_000;

/**
 * Captions for a YouTube range need the video owner's OAuth, so this uses
 * the same OpenRouter nova-3 pass as section QA. Missing key, test runs,
 * and a slow reply all return no text.
 */
export async function transcribeCloneReference(
  audio: Buffer,
  contentType: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ text: string | null; ms: number }> {
  const started = Date.now();
  const apiKey = openRouterKey(env);
  const vitest = Boolean(env.VITEST || process.env.VITEST);
  if (!apiKey || (vitest && env.TTS_SECTION_QA !== "1")) {
    return { text: null, ms: 0 };
  }
  try {
    const text = (
      await transcribeWithOpenRouter(
        audio,
        contentType,
        apiKey,
        env,
        CLONE_TRANSCRIPT_WAIT_MS
      )
    ).trim();
    const ms = Date.now() - started;
    console.info(`[clone] transcript ms=${ms} chars=${text.length}`);
    return { text: text ? text.slice(0, 4000) : null, ms };
  } catch {
    const ms = Date.now() - started;
    console.info(`[clone] transcript skipped ms=${ms}`);
    return { text: null, ms };
  }
}

export { audioDurationSeconds } from "@/lib/tts/mp3-duration";
import { audioDurationSeconds } from "@/lib/tts/mp3-duration";

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
  return fetchTranscript({
    url: `${base}/audio/transcriptions`,
    apiKey,
    audio,
    format: extOf(contentType),
    waitMs,
    referer: env.NEXT_PUBLIC_APP_URL || "https://echomancer.xyz",
    model: OPENROUTER_MODEL,
  });
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

function logQaSkipped(jobId: string, env: NodeJS.ProcessEnv): void {
  if (qaSkippedJobs.has(jobId)) return;
  qaSkippedJobs.add(jobId);
  const provider = resolveSttProvider(env);
  const why =
    provider === "deepgram"
      ? "deepgram needs OPENROUTER_API_KEY"
      : provider === "local"
        ? "whisper sidecar missing"
        : "disabled";
  console.log(`[Job ${jobId}] qa skipped: ${why}`);
}

const qaDisabledJobs = new Set<string>();

function logQaDisabled(jobId: string): void {
  if (qaDisabledJobs.has(jobId)) return;
  qaDisabledJobs.add(jobId);
  console.log(`[Job ${jobId}] qa skipped: disabled`);
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
  synthesize: (text: string, remainingMs: number) => Promise<{ audio: Buffer; contentType: string } | null>;
  regenerationBudgetMs?: number;
  rate: SpeechRate;
  env?: NodeJS.ProcessEnv;
}): Promise<{ audio: Buffer; contentType: string; durationSec: number | null }> {
  const env = opts.env ?? process.env;
  if (qaExplicitlyDisabled(env)) {
    logQaDisabled(opts.jobId);
    return { ...opts.first, durationSec: null };
  }
  const provider = resolveQaProvider(env);
  if (!provider) {
    logQaSkipped(opts.jobId, env);
    return { ...opts.first, durationSec: null };
  }
  const started = Date.now();
  const deadline = started + (opts.regenerationBudgetMs ?? qaRegenerationBudgetMs(60_000));
  let attempts = QA_REGENERATION_ATTEMPTS;
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error("qa regeneration budget");
    return ms;
  };
  const bounded = async <T>(work: (ms: number) => Promise<T>): Promise<T> => {
    const ms = remaining();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work(ms),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("qa regeneration budget")), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const synthesize = (text: string) => {
    if (attempts-- <= 0) throw new Error("qa regeneration attempts");
    return bounded((ms) => opts.synthesize(text, ms));
  };

  let fallback: { audio: Buffer; contentType: string; durationSec: number | null } = {
    ...opts.first,
    durationSec: null,
  };
  try {
    const judged = async (
      audio: Buffer,
      contentType: string
    ): Promise<Judged> => {
      const transcript = await bounded(async (ms) => {
        if (provider !== "local") {
          return transcribeWithOpenRouter(
            audio,
            contentType,
            openRouterKey(env),
            env,
            Math.min(qaWaitMs(env), ms)
          );
        }
        if (insideCpuTask()) return transcribeLocally(audio, env, ms);
        const cpu = await tryCpuSlot("whisper", ms);
        if (cpu === null) throw new CpuSaturatedError("whisper");
        try {
          return await transcribeLocally(audio, env, ms);
        } finally {
          if (cpu !== "unavailable") await cpu.release();
        }
      });
      const aligned = checkTranscriptAlignment(opts.sourceText, transcript);
      // Included in `ms=`. In process so a duration read cannot hold the section.
      const durationSec = audioDurationSeconds(audio);
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

    const secondAudio = await synthesize(opts.sourceText);
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
      const left = await synthesize(parts[0]);
      const right = left ? await synthesize(parts[1]) : null;
      if (left && right) {
        const assembled = await bounded((ms) => assembleSectionTakes(
          [left, right], Math.min(ms, QA_ASSEMBLY_BUDGET_MS), env
        ));
        const joined = await judged(assembled.audio, assembled.contentType);
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
    if (err instanceof CpuSaturatedError) throw err;
    console.warn(
      `[Job ${opts.jobId}] section ${opts.index} qa wer=- flags=- action=open via=${provider} ms=${Date.now() - started}`,
      err instanceof Error ? err.message : err
    );
    return fallback;
  }
}
