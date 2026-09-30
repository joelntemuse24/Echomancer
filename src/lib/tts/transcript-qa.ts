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

export type QaProviderName = "openrouter";

const qaSkippedJobs = new Set<string>();

function openRouterKey(env: NodeJS.ProcessEnv): string {
  return (env.OPENROUTER_API_KEY || env.OPEN_ROUTER_API_KEY || "").trim();
}

/** `TTS_SECTION_QA_ENABLED=0` (or false/off) skips QA even when a key is set. */
export function qaExplicitlyDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.TTS_SECTION_QA_ENABLED?.trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "off";
}

/**
 * OpenRouter when its key is set.
 * Vitest plants a fake OpenRouter key; that path stays off unless
 * `TTS_SECTION_QA=1`.
 */
export function resolveQaProvider(
  env: NodeJS.ProcessEnv = process.env
): QaProviderName | null {
  if (qaExplicitlyDisabled(env)) return null;
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

const MPEG1_RATES: Record<number, readonly number[]> = {
  3: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
};
const MPEG2_RATES: Record<number, readonly number[]> = {
  3: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
  1: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};

function mpegFrame(
  audio: Buffer,
  offset: number
): { length: number; samples: number; sampleRate: number } | null {
  if (offset + 4 > audio.length) return null;
  const b1 = audio[offset + 1]!;
  const b2 = audio[offset + 2]!;
  if (audio[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const version = (b1 >> 3) & 0x3;
  const layer = (b1 >> 1) & 0x3;
  if (version === 1 || layer === 0) return null;
  const bitrateIndex = (b2 >> 4) & 0xf;
  const sampleIndex = (b2 >> 2) & 0x3;
  const padding = (b2 >> 1) & 0x1;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) return null;
  const mpeg1 = version === 3;
  const table = mpeg1 ? MPEG1_RATES : MPEG2_RATES;
  const bitrate = table[layer]?.[bitrateIndex] ?? 0;
  if (!bitrate) return null;
  const base = [44100, 48000, 32000][sampleIndex] ?? 0;
  const sampleRate = mpeg1 ? base : version === 2 ? base / 2 : base / 4;
  if (!sampleRate) return null;
  const layer1 = layer === 3;
  const samples = layer1 ? 384 : mpeg1 || layer === 2 ? 1152 : 576;
  const length = layer1
    ? Math.floor((12 * bitrate * 1000) / sampleRate + padding) * 4
    : Math.floor(((samples / 8) * bitrate * 1000) / sampleRate + padding);
  if (length < 4 || offset + length > audio.length) return null;
  return { length, samples, sampleRate };
}

function mp3DurationSeconds(audio: Buffer): number | null {
  let offset = 0;
  if (
    audio.length >= 10 &&
    audio[0] === 0x49 &&
    audio[1] === 0x44 &&
    audio[2] === 0x33
  ) {
    const size =
      ((audio[6]! & 0x7f) << 21) |
      ((audio[7]! & 0x7f) << 14) |
      ((audio[8]! & 0x7f) << 7) |
      (audio[9]! & 0x7f);
    offset = 10 + size + ((audio[5]! & 0x10) !== 0 ? 10 : 0);
  }
  let seconds = 0;
  let frames = 0;
  let steps = 0;
  while (offset + 4 <= audio.length && steps < audio.length) {
    steps += 1;
    const frame = mpegFrame(audio, offset);
    if (!frame) {
      offset += 1;
      continue;
    }
    seconds += frame.samples / frame.sampleRate;
    offset += frame.length;
    frames += 1;
  }
  if (frames < 2 || !(seconds > 0)) return null;
  return seconds;
}

function wavDurationSeconds(audio: Buffer): number | null {
  if (audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  let offset = 12;
  let byteRate = 0;
  let dataBytes = 0;
  while (offset + 8 <= audio.length) {
    const id = audio.toString("ascii", offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt " && start + 16 <= audio.length) {
      byteRate = audio.readUInt32LE(start + 8);
    } else if (id === "data") {
      dataBytes = Math.max(0, Math.min(size, audio.length - start));
      break;
    }
    const step = 8 + size + (size % 2);
    if (step < 8) break;
    offset += step;
  }
  if (!(byteRate > 0) || !(dataBytes > 0)) return null;
  return dataBytes / byteRate;
}

/** MP3 frame walk or WAV header. Null when the container is neither. */
export function audioDurationSeconds(audio: Buffer): number | null {
  if (audio.length < 4) return null;
  if (audio.length >= 12 && audio.toString("ascii", 0, 4) === "RIFF") {
    return wavDurationSeconds(audio);
  }
  return mp3DurationSeconds(audio);
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

function logQaSkipped(jobId: string): void {
  if (qaSkippedJobs.has(jobId)) return;
  qaSkippedJobs.add(jobId);
  console.log(`[Job ${jobId}] qa skipped: no provider`);
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
  synthesize: (text: string) => Promise<{ audio: Buffer; contentType: string } | null>;
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
    if (!openRouterKey(env)) logQaSkipped(opts.jobId);
    return { ...opts.first, durationSec: null };
  }
  const apiKey = openRouterKey(env);
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
      const transcript = await transcribeWithOpenRouter(
        audio,
        contentType,
        apiKey,
        env,
        waitMs
      );
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
