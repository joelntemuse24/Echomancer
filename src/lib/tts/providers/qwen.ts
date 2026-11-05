/**
 * Alibaba Model Studio Qwen TTS (`qwen-audio-3.1-tts-flash`, Singapore).
 *
 * A section is chunked to ~10–15 s of audio per call at sentence
 * boundaries (`qwen-chunks.ts`), each chunk is synthesized with a fixed seed
 * (so a retake of the same text and voice should repeat; the A/B runner's
 * `--determinism` arm checks that), and the takes are joined
 * locally with pauses, fades, and level matching (`qwen-join.ts`).
 *
 * Every network call goes through `qwenSynthesizeOnce` (speech) or
 * `qwenCustomization` (voice enrollment). The key is read from the
 * environment and never logged; error bodies are redacted before they are
 * thrown.
 *
 * Env:
 *   DASHSCOPE_API_KEY            (or QWEN_TTS_API_KEY)
 *   DASHSCOPE_WORKSPACE_ID       → https://<ws>.ap-southeast-1.maas.aliyuncs.com/api/v1
 *   DASHSCOPE_BASE_URL           optional full override of that base
 *   QWEN_TTS_MODEL               default qwen-audio-3.1-tts-flash
 *   QWEN_TTS_SEED                default 42 (0–65535)
 *   QWEN_TTS_CHUNK_CHARS         default 220 (~12 s)
 *   QWEN_TTS_CONCURRENCY         default 3 chunk calls in flight
 *   QWEN_TTS_CANDIDATES          default 1; >1 renders extra seeds per chunk
 *                                and keeps the lowest artifact score (needs a scorer)
 *   QWEN_TTS_POST                default "deline,degate"; "off" for raw joins
 */

import { mapPool } from "@/lib/async-pool";
import { isEmptyOrSilentAudio } from "@/lib/tts/audio-guard";
import { chunkQwenText, type QwenChunk } from "@/lib/tts/qwen-chunks";
import {
  joinQwenChunks,
  parseQwenPost,
  type QwenPost,
} from "@/lib/tts/qwen-join";
import type {
  SynthesizeInput,
  SynthesizeResult,
  TtsProviderAdapter,
} from "@/lib/tts/types";

export const QWEN_DEFAULT_MODEL = "qwen-audio-3.1-tts-flash";
export const QWEN_DEFAULT_SEED = 42;
export const QWEN_MAX_ATTEMPTS = 4;

export type QwenConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export function getQwenApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.DASHSCOPE_API_KEY?.trim() || env.QWEN_TTS_API_KEY?.trim() || undefined;
}

export function qwenBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.DASHSCOPE_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const ws = env.DASHSCOPE_WORKSPACE_ID?.trim();
  return ws ? `https://${ws}.ap-southeast-1.maas.aliyuncs.com/api/v1` : undefined;
}

export function isQwenConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(getQwenApiKey(env) && qwenBaseUrl(env));
}

export function resolveQwenConfig(env: NodeJS.ProcessEnv = process.env): QwenConfig {
  const apiKey = getQwenApiKey(env);
  const baseUrl = qwenBaseUrl(env);
  if (!apiKey || !baseUrl) {
    throw new Error(
      "Qwen TTS is not configured (set DASHSCOPE_API_KEY and DASHSCOPE_WORKSPACE_ID)."
    );
  }
  return { apiKey, baseUrl, model: env.QWEN_TTS_MODEL?.trim() || QWEN_DEFAULT_MODEL };
}

export function clampSeed(seed: number | undefined): number {
  if (seed === undefined || !Number.isFinite(seed)) return QWEN_DEFAULT_SEED;
  return ((Math.round(seed) % 65536) + 65536) % 65536;
}

/** Seed for the k-th candidate of a chunk. k = 0 is the requested seed. */
export function candidateSeed(seed: number, k: number): number {
  return clampSeed(seed + k * 7919);
}

function intEnv(raw: string | undefined, fallback: number, lo: number, hi: number): number {
  const n = Number(raw);
  if (raw === undefined || raw === "" || !Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

export class QwenTtsError extends Error {
  status: number | null;
  retryable: boolean;
  retryAfterMs: number | null;
  constructor(message: string, opts: { status?: number | null; retryable: boolean; retryAfterMs?: number | null }) {
    super(message);
    this.name = "QwenTtsError";
    this.status = opts.status ?? null;
    this.retryable = opts.retryable;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

export function redactSecret(text: string, secret: string | undefined): string {
  let out = text;
  if (secret) out = out.split(secret).join("<key>");
  return out.replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer <key>");
}

/** Alibaba returns http:// OSS links; fetch them over TLS. */
export function httpsAudioUrl(url: string): string {
  return url.replace(/^http:\/\//i, "https://");
}

export type QwenSynthRequest = {
  text: string;
  voice: string;
  model?: string;
  seed?: number;
  format?: "mp3" | "wav";
  sampleRate?: number;
  languageHints?: string[];
  /** Leave unset for cloned narrators: it strengthened the 1.21 kHz line on one clone. */
  instruction?: string;
};

export type QwenSynthResponse = {
  audio: Buffer;
  requestId: string | null;
  usage: Record<string, unknown> | null;
  /** Host of the returned audio link (the signed query is not kept). */
  audioHost: string | null;
  latencyMs: number;
};

export type QwenHttpOptions = {
  config?: QwenConfig;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export function buildQwenSynthBody(req: QwenSynthRequest, model: string): Record<string, unknown> {
  const input: Record<string, unknown> = {
    text: req.text,
    voice: req.voice,
    format: req.format ?? "mp3",
    sample_rate: req.sampleRate ?? 24_000,
    language_hints: req.languageHints ?? ["en"],
    seed: clampSeed(req.seed),
  };
  if (req.instruction?.trim()) input.instruction = req.instruction.trim();
  return { model: req.model || model, input };
}

function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const s = Number(header.trim());
  return Number.isFinite(s) && s >= 0 ? Math.min(60_000, s * 1000) : null;
}

function signalWithTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

/**
 * One synthesis call: POST SpeechSynthesizer, then download the returned
 * audio link. This is the only function that talks to the speech API.
 */
export async function qwenSynthesizeOnce(
  req: QwenSynthRequest,
  opts: QwenHttpOptions = {}
): Promise<QwenSynthResponse> {
  const config = opts.config ?? resolveQwenConfig();
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const started = Date.now();
  let res: Response;
  try {
    res = await doFetch(`${config.baseUrl}/services/audio/tts/SpeechSynthesizer`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildQwenSynthBody(req, config.model)),
      signal: signalWithTimeout(opts.signal, timeoutMs),
    });
  } catch (err) {
    opts.signal?.throwIfAborted();
    throw new QwenTtsError(
      `Qwen TTS request failed: ${redactSecret(err instanceof Error ? err.message : String(err), config.apiKey)}`,
      { retryable: true }
    );
  }

  const raw = await res.text().catch(() => "");
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new QwenTtsError(
      `Qwen TTS ${res.status}: ${redactSecret(raw.slice(0, 400), config.apiKey)}`,
      { status: res.status, retryable, retryAfterMs: retryAfterMs(res.headers.get("retry-after")) }
    );
  }
  let body: {
    request_id?: string;
    usage?: Record<string, unknown>;
    output?: { audio?: { url?: string } };
    code?: string;
    message?: string;
  };
  try {
    body = JSON.parse(raw);
  } catch {
    throw new QwenTtsError("Qwen TTS returned a non-JSON body", { status: res.status, retryable: true });
  }
  const url = body.output?.audio?.url;
  if (!url) {
    throw new QwenTtsError(
      `Qwen TTS returned no audio${body.code ? ` (${body.code}: ${redactSecret(body.message ?? "", config.apiKey)})` : ""}`,
      { status: res.status, retryable: true }
    );
  }

  const audioUrl = httpsAudioUrl(url);
  let audio: Buffer;
  try {
    const dl = await doFetch(audioUrl, { signal: signalWithTimeout(opts.signal, timeoutMs) });
    if (!dl.ok) {
      throw new QwenTtsError(`Qwen audio download ${dl.status}`, {
        status: dl.status,
        retryable: dl.status === 429 || dl.status >= 500 || dl.status === 403,
      });
    }
    audio = Buffer.from(await dl.arrayBuffer());
  } catch (err) {
    opts.signal?.throwIfAborted();
    if (err instanceof QwenTtsError) throw err;
    throw new QwenTtsError(
      `Qwen audio download failed: ${err instanceof Error ? err.message : String(err)}`,
      { retryable: true }
    );
  }
  let audioHost: string | null = null;
  try {
    audioHost = new URL(audioUrl).host;
  } catch {
    audioHost = null;
  }
  return {
    audio,
    requestId: body.request_id ?? null,
    usage: body.usage ?? null,
    audioHost,
    latencyMs: Date.now() - started,
  };
}

export type QwenSynthFn = (req: QwenSynthRequest, opts?: QwenHttpOptions) => Promise<QwenSynthResponse>;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true }
    );
  });

/** Retry 429 / 5xx / network / silent-audio failures with backoff. */
export async function qwenSynthesizeWithRetry(
  req: QwenSynthRequest,
  opts: QwenHttpOptions & {
    synth?: QwenSynthFn;
    attempts?: number;
    backoffMs?: number;
    onAttempt?: (info: { attempt: number; error?: string }) => void;
  } = {}
): Promise<QwenSynthResponse & { attempts: number }> {
  const synth = opts.synth ?? qwenSynthesizeOnce;
  const attempts = opts.attempts ?? QWEN_MAX_ATTEMPTS;
  const backoff = opts.backoffMs ?? 1000;
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const out = await synth(req, opts);
      if (isEmptyOrSilentAudio(out.audio)) {
        throw new QwenTtsError("Qwen TTS returned empty or silent audio", { retryable: true });
      }
      opts.onAttempt?.({ attempt });
      return { ...out, attempts: attempt };
    } catch (err) {
      opts.signal?.throwIfAborted();
      last = err;
      const retryable = err instanceof QwenTtsError ? err.retryable : false;
      opts.onAttempt?.({ attempt, error: err instanceof Error ? err.message : String(err) });
      if (!retryable || attempt === attempts) break;
      const wait =
        (err instanceof QwenTtsError && err.retryAfterMs) ||
        Math.min(15_000, backoff * 2 ** (attempt - 1));
      await sleep(wait, opts.signal);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Lower is better. Return null when the take cannot be scored. */
export type QwenChunkScorer = (audio: Buffer, chunk: QwenChunk) => Promise<number | null>;

export type QwenChunkTake = {
  chunk: QwenChunk;
  audio: Buffer;
  seed: number;
  score: number | null;
  requestId: string | null;
  usage: Record<string, unknown> | null;
  attempts: number;
  latencyMs: number;
  candidates: { seed: number; score: number | null }[];
};

export type QwenRenderOptions = {
  voice: string;
  model?: string;
  seed?: number;
  chunkChars?: number;
  concurrency?: number;
  candidates?: number;
  scorer?: QwenChunkScorer;
  post?: QwenPost;
  instruction?: string;
  signal?: AbortSignal;
  synth?: QwenSynthFn;
  config?: QwenConfig;
  /** Override decode for tests (PCM in, PCM out). */
  decode?: (audio: Buffer) => Promise<Buffer>;
  encode?: boolean;
  onChunk?: (take: QwenChunkTake) => void;
};

export async function renderQwenChunk(
  chunk: QwenChunk,
  opts: QwenRenderOptions
): Promise<QwenChunkTake> {
  const seed = clampSeed(opts.seed);
  const n = Math.max(1, Math.floor(opts.candidates ?? 1));
  const tried: QwenChunkTake[] = [];
  for (let k = 0; k < n; k++) {
    const s = candidateSeed(seed, k);
    const out = await qwenSynthesizeWithRetry(
      { text: chunk.text, voice: opts.voice, model: opts.model, seed: s, instruction: opts.instruction },
      { synth: opts.synth, signal: opts.signal, config: opts.config }
    );
    const score = opts.scorer ? await opts.scorer(out.audio, chunk) : null;
    tried.push({
      chunk,
      audio: out.audio,
      seed: s,
      score,
      requestId: out.requestId,
      usage: out.usage,
      attempts: out.attempts,
      latencyMs: out.latencyMs,
      candidates: [],
    });
  }
  const scored = tried.filter((t) => t.score !== null);
  const best = scored.length
    ? scored.reduce((a, b) => (b.score! < a.score! ? b : a))
    : tried[0]!;
  return { ...best, candidates: tried.map((t) => ({ seed: t.seed, score: t.score })) };
}

export type QwenRenderResult = SynthesizeResult & {
  takes: QwenChunkTake[];
  pcm: Buffer;
  gainsDb: number[];
};

/** Chunk → synthesize (bounded concurrency, order kept) → join. */
export async function renderQwenText(text: string, opts: QwenRenderOptions): Promise<QwenRenderResult> {
  const chunks = chunkQwenText(text, { targetChars: opts.chunkChars });
  if (!chunks.length) throw new Error("Qwen TTS: nothing to synthesize");
  const takes = await mapPool(chunks, Math.max(1, opts.concurrency ?? 3), async (chunk) => {
    const take = await renderQwenChunk(chunk, opts);
    opts.onChunk?.(take);
    return take;
  });
  const joined = await joinQwenChunks(
    takes.map((t) => ({ audio: t.audio, boundary: t.chunk.boundary })),
    { post: opts.post ?? parseQwenPost(undefined), decode: opts.decode, encode: opts.encode }
  );
  return {
    audio: joined.audio,
    contentType: opts.encode === false ? "audio/L16;rate=24000" : "audio/mpeg",
    durationHintSeconds: joined.durationSeconds,
    takes,
    pcm: joined.pcm,
    gainsDb: joined.gainsDb,
  };
}

function qwenModelFor(input: SynthesizeInput, env: NodeJS.ProcessEnv): string | undefined {
  const m = input.model?.trim();
  return m && m.startsWith("qwen") ? m : env.QWEN_TTS_MODEL?.trim() || undefined;
}

async function synthesizeQwen(input: SynthesizeInput): Promise<SynthesizeResult> {
  const env = process.env;
  const config = resolveQwenConfig(env);
  const result = await renderQwenText(input.text, {
    voice: input.voiceId,
    model: qwenModelFor(input, env),
    seed: input.seed ?? intEnv(env.QWEN_TTS_SEED, QWEN_DEFAULT_SEED, 0, 65535),
    chunkChars: intEnv(env.QWEN_TTS_CHUNK_CHARS, 220, 80, 600),
    concurrency: intEnv(env.QWEN_TTS_CONCURRENCY, 3, 1, 8),
    candidates: intEnv(env.QWEN_TTS_CANDIDATES, 1, 1, 4),
    post: parseQwenPost(env.QWEN_TTS_POST),
    signal: input.signal,
    config,
  });
  return {
    audio: result.audio,
    contentType: result.contentType,
    durationHintSeconds: result.durationHintSeconds,
  };
}

async function* streamQwen(input: SynthesizeInput): AsyncIterable<Uint8Array> {
  const result = await synthesizeQwen(input);
  yield new Uint8Array(result.audio);
}

export const qwenTtsProvider: TtsProviderAdapter = {
  id: "qwen",
  synthesize: synthesizeQwen,
  synthesizeStream: streamQwen,
  streamContentType: "audio/mpeg",
};

// --------------------------------------------------------------------------
// Voice enrollment (free on Model Studio)

export type QwenEnrollOptions = {
  /** Prepared reference: WAV 16-bit mono (see prepareQwenReference). */
  audio: Buffer;
  contentType?: string;
  /** Lowercase letters/digits, under 10 chars; becomes part of the voice id. */
  prefix: string;
  targetModel?: string;
  maxPromptSeconds?: number;
  /** Alibaba denoise/normalize. Off for clean studio references. */
  preprocess?: boolean;
  languageHints?: string[];
};

/** POST …/services/audio/tts/customization. The only enrollment call. */
export async function qwenCustomization(
  input: Record<string, unknown>,
  opts: QwenHttpOptions = {}
): Promise<Record<string, unknown>> {
  const config = opts.config ?? resolveQwenConfig();
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${config.baseUrl}/services/audio/tts/customization`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "voice-enrollment", input }),
    signal: signalWithTimeout(opts.signal, opts.timeoutMs ?? 180_000),
  });
  const raw = await res.text().catch(() => "");
  if (!res.ok) {
    throw new QwenTtsError(`Qwen enrollment ${res.status}: ${redactSecret(raw.slice(0, 400), config.apiKey)}`, {
      status: res.status,
      retryable: res.status === 429 || res.status >= 500,
    });
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

export function sanitizeQwenPrefix(prefix: string): string {
  const p = prefix.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 9);
  return p || "echo";
}

export async function createQwenVoice(
  opts: QwenEnrollOptions,
  http: QwenHttpOptions = {}
): Promise<string> {
  const config = http.config ?? resolveQwenConfig();
  const mime = opts.contentType || "audio/wav";
  const body = await qwenCustomization(
    {
      action: "create_voice",
      target_model: opts.targetModel || config.model,
      prefix: sanitizeQwenPrefix(opts.prefix),
      audio: `data:${mime};base64,${opts.audio.toString("base64")}`,
      language_hints: opts.languageHints ?? ["en"],
      max_prompt_audio_length: Math.max(3, Math.min(30, opts.maxPromptSeconds ?? 6)),
      enable_preprocess: opts.preprocess ?? false,
    },
    { ...http, config }
  );
  const voiceId = (body.output as { voice_id?: string } | undefined)?.voice_id;
  if (!voiceId) throw new QwenTtsError("Qwen enrollment returned no voice_id", { retryable: false });
  return voiceId;
}

/** Poll list_voice until the voice leaves DEPLOYING. Returns its status. */
export async function waitForQwenVoice(
  voiceId: string,
  http: QwenHttpOptions & { pollMs?: number; maxPolls?: number } = {}
): Promise<string> {
  const pollMs = http.pollMs ?? 3000;
  for (let i = 0; i < (http.maxPolls ?? 60); i++) {
    const body = await qwenCustomization(
      { action: "list_voice", page_size: 100, page_index: 0 },
      http
    ).catch(() => null);
    const list = ((body?.output as { voice_list?: { voice_id: string; status: string }[] } | undefined)
      ?.voice_list) ?? [];
    const hit = list.find((v) => v.voice_id === voiceId);
    if (hit && hit.status !== "DEPLOYING") return hit.status;
    await sleep(pollMs, http.signal);
  }
  return "TIMEOUT";
}
