/**
 * Direct Fish Audio TTS + voice cloning.
 *
 * Clone creation requires FISH_API_KEY. This adapter can synthesize saved clone
 * samples through OpenRouter, with direct Fish as the fallback.
 *
 * Streaming: Fish `POST /v1/tts` returns chunked audio (HTTP streaming). Prefer
 * that for previews and live listen — lower time-to-first-byte than buffering
 * the whole clip. WebSocket `/v1/tts/live` is for token-by-token LLM text; we
 * do not proxy it on serverless (full text is already available).
 *
 * Docs: https://docs.fish.audio/features/realtime-streaming
 *       https://docs.fish.audio/features/voice-cloning
 */

import type {
  SynthesizeInput,
  SynthesizeResult,
  TtsProviderAdapter,
} from "@/lib/tts/types";
import { sniffAudioContentType } from "@/lib/tts/pcm-wav";
import { beginLiveFish } from "@/lib/tts/fish-slots";
import { FISH_SEEDED_VOICES } from "@/lib/tts/catalog/allowlist";
import { isCuratedFishStockVoice } from "@/lib/tts/curated-fish-stock";

import { modalCloneJobBlocked, parseCloneProviderPin, resolveLegacyDramaPin, type CloneProviderChoice } from "./modal-clone-guard";
import {
  synthesizeModalClone,
  usesModalClone,
} from "./modal-clone";
import { isFishCloneCatalogId } from "@/lib/tts/fish-clone";

const FISH_API_BASE = (
  process.env.FISH_API_BASE_URL || "https://api.fish.audio"
).replace(/\/+$/, "");

/** Native Fish model id for the free S2.1 Pro tier. */
export const FISH_NATIVE_FREE_MODEL = "s2.1-pro-free";

export type FishLatency = "low" | "normal" | "balanced";

export class FishRateLimitError extends Error {
  retryAfterMs: number;
  constructor(retryAfterMs: number, message: string) {
    super(message);
    this.name = "FishRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * No engine is left that can speak this clone.
 *
 * Thrown instead of substituting a different voice. Callers surface the message
 * to the person and, for a book, leave the job visibly failed: a silent switch
 * to Drama 3 was how a hosted take once ended up stored and served as the
 * customer's own S2 preview.
 */
export class CloneEngineUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloneEngineUnavailableError";
  }
}

export function parseRetryAfterMs(header: string | null): number {
  if (!header) return 2_000;
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(60_000, Math.max(250, Math.round(seconds * 1000)));
  }
  const when = Date.parse(trimmed);
  if (!Number.isNaN(when)) {
    return Math.min(60_000, Math.max(250, when - Date.now()));
  }
  return 2_000;
}

export function getFishApiKey(): string | undefined {
  const key =
    process.env.FISH_API_KEY?.trim() ||
    process.env.FISH_AUDIO_API_KEY?.trim();
  return key || undefined;
}

export function isFishConfigured(): boolean {
  return Boolean(getFishApiKey());
}

/** True when this catalog voice should use the direct Fish HTTP stream. */
export function isFishLiveVoice(opts: {
  provider?: string | null;
  model?: string | null;
  catalogVoiceId?: string | null;
  tags?: string[] | null;
}): boolean {
  if (!isFishConfigured()) return false;
  if (opts.provider === "fish") return true;
  if (opts.catalogVoiceId?.startsWith("clone:")) return true;
  const model = (opts.model || "").toLowerCase();
  if (model.includes("fish-audio") || model.includes("s2.1-pro")) return true;
  const tags = opts.tags || [];
  return tags.some((t) => t.toLowerCase() === "fish-audio");
}

/**
 * Native Fish `reference_id` is only for account-scoped clones.
 * OpenRouter / static catalog UUIDs (e.g. fish-narrator) are not Fish
 * references — posting them yields 400 "Reference not found".
 * Stock Narrator uses Fish's default S2.1 Pro Free voice (omit reference_id).
 * Docs: https://docs.fish.audio/developer-guide/getting-started/quickstart
 */
export function shouldAttachFishReferenceId(opts: {
  voiceId?: string | null;
  catalogVoiceId?: string | null;
}): boolean {
  const voiceId = opts.voiceId?.trim();
  if (!voiceId) return false;
  if (opts.catalogVoiceId?.startsWith("clone:")) return true;
  if (
    isCuratedFishStockVoice({
      id: opts.catalogVoiceId,
      catalogVoiceId: opts.catalogVoiceId,
      providerVoiceId: voiceId,
    })
  ) {
    return true;
  }
  if (opts.catalogVoiceId === "fish-narrator") return false;
  if (FISH_SEEDED_VOICES.some((v) => v.id === voiceId)) return false;
  // No catalog id: attach only when this is not a known OpenRouter catalog UUID.
  return !opts.catalogVoiceId;
}

function requireFishKey(): string {
  const key = getFishApiKey();
  if (!key) {
    throw new Error(
      "FISH_API_KEY is not configured (required for Fish voice cloning)."
    );
  }
  return key;
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

function nativeModel(model?: string): string {
  if (!model) return FISH_NATIVE_FREE_MODEL;
  if (model.includes("fish-audio/") || model.includes(":free")) {
    return FISH_NATIVE_FREE_MODEL;
  }
  // Already a native id (s2.1-pro-free, s2-pro, …)
  if (!model.includes("/")) return model;
  return FISH_NATIVE_FREE_MODEL;
}

export type FishCloneResult = {
  fishVoiceId: string;
  state: string;
  title: string;
};

/**
 * Create a persistent Fish voice model from a sample clip.
 * POST https://api.fish.audio/model (multipart)
 */
export async function createFishVoiceClone(opts: {
  title: string;
  audio: Buffer;
  filename: string;
  contentType?: string;
  description?: string;
  transcript?: string;
  signal?: AbortSignal;
}): Promise<FishCloneResult> {
  const apiKey = requireFishKey();
  const form = new FormData();
  form.set("type", "tts");
  form.set("title", opts.title.slice(0, 80));
  form.set("visibility", "private");
  form.set("train_mode", "fast");
  form.set("enhance_audio_quality", "true");
  if (opts.description) form.set("description", opts.description.slice(0, 500));
  if (opts.transcript?.trim()) form.set("texts", opts.transcript.trim());

  const bytes = new Uint8Array(opts.audio);
  const blob = new Blob([bytes], {
    type: opts.contentType || "application/octet-stream",
  });
  form.set("voices", blob, opts.filename || "sample.wav");

  const res = await fetch(`${FISH_API_BASE}/model`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: form,
    signal: opts.signal
      ? AbortSignal.any([opts.signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `Fish clone ${res.status}: ${errText.slice(0, 500) || res.statusText}`
    );
  }

  const data = (await res.json()) as {
    _id?: string;
    id?: string;
    state?: string;
    title?: string;
  };
  const fishVoiceId = data._id || data.id;
  if (!fishVoiceId) {
    throw new Error("Fish clone response missing voice id");
  }

  return {
    fishVoiceId,
    state: data.state || "trained",
    title: data.title || opts.title,
  };
}

function buildTtsBody(
  input: SynthesizeInput,
  latency: FishLatency
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    text: input.text,
    format: "mp3",
    latency,
    normalize: true,
    sample_rate: 44100,
    mp3_bitrate: 192,
  };
  if (
    shouldAttachFishReferenceId({
      voiceId: input.voiceId,
      catalogVoiceId: input.catalogVoiceId,
    })
  ) {
    body.reference_id = input.voiceId;
  }
  if (input.speed && input.speed !== 1) {
    body.prosody = { speed: input.speed };
  }
  if (
    typeof input.chunkLength === "number" &&
    input.chunkLength >= 100 &&
    input.chunkLength <= 300
  ) {
    body.chunk_length = Math.round(input.chunkLength);
  }
  return body;
}

/**
 * Which clone engine this call may use.
 *
 * A take-home book is pinned once (`jobs.provider_pin`) so it cannot change
 * narrator halfway through. Live Listen has no pin and uses the product
 * engine, with direct Fish as the only stand-in — the same voice, because Fish
 * trained the reference. Drama 3 is never chosen, here or anywhere.
 *
 * `SynthesizeInput.allowFallback === false` means the caller has decided this
 * book may not switch engines, so a failure is rethrown instead of being
 * absorbed.
 */
function pinnedCloneProvider(input: SynthesizeInput): CloneProviderChoice | null {
  return parseCloneProviderPin(input.cloneProviderPin);
}
export async function openFishTtsStream(
  input: SynthesizeInput,
  latency: FishLatency
): Promise<Response> {
  // Cloned voices: self-hosted S2-Pro, then direct Fish. Both speak the same
  // clone — Fish is the account that trained it — so this is not a narrator
  // change. There is no Drama 3 rung: a take from it is a different voice, and
  // substituting one is how a Drama render once ended up stored and served as
  // "the S2 preview".
  const pin = pinnedCloneProvider(input);
  const mayFallback = input.allowFallback !== false;
  // A legacy `drama3` row is resolved to a real engine rather than failing.
  const engine: CloneProviderChoice | null =
    pin === "drama3"
      ? resolveLegacyDramaPin({
          modalConfigured: usesModalClone(input.catalogVoiceId),
          jobBlocked: modalCloneJobBlocked(input.jobId),
        })
      : pin;
  // An unpinned call (Live Listen) uses the product engine when it is there.
  const useModal = engine
    ? engine === "modal"
    : usesModalClone(input.catalogVoiceId);
  if (useModal && !modalCloneJobBlocked(input.jobId)) {
    try {
      const { audio, contentType } = await synthesizeModalClone(input);
      return new Response(new Uint8Array(audio), {
        headers: { "Content-Type": contentType },
      });
    } catch (err) {
      input.signal?.throwIfAborted();
      if (!mayFallback) {
        // A pinned book parks (cold) or fails visibly instead of switching
        // engine. Cold is not an error: the worker comes back later.
        throw err;
      }
      console.warn(
        "[clone-tts] Modal S2 failed; falling back to direct Fish (same voice):",
        err instanceof Error ? err.message : err
      );
    }
  }
  if (engine && engine !== "modal" && engine !== "fish") {
    throw new Error(`Unknown clone provider pin: ${engine}`);
  }
  // `engine`, not `pin`: a legacy `drama3` row has already been resolved to a
  // real engine above, and forcing it to fail would strand that book.
  if (engine && engine !== "fish" && !mayFallback) {
    throw new Error(`Clone provider ${engine} failed and this book may not switch engines`);
  }
  // Fish is the last rung, and it is only reached when this voice is a Fish
  // clone that Fish can synthesize from its private reference. A clone with no
  // reference id has nowhere left to go; failing loudly is the whole point of
  // removing the Drama rung.
  if (isFishCloneCatalogId(input.catalogVoiceId) && !shouldAttachFishReferenceId({
    voiceId: input.voiceId,
    catalogVoiceId: input.catalogVoiceId,
  })) {
    throw new CloneEngineUnavailableError(
      "This cloned voice has no Fish reference to fall back to, and we will not substitute a different voice.",
    );
  }
  const apiKey = requireFishKey();
  const model = nativeModel(input.model);

  const res = await fetch(`${FISH_API_BASE}/v1/tts`, {
    method: "POST",
    headers: {
      ...authHeaders(apiKey),
      "Content-Type": "application/json",
      model,
    },
    body: JSON.stringify(buildTtsBody(input, latency)),
    signal: input.signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    if (res.status === 429) {
      throw new FishRateLimitError(
        parseRetryAfterMs(res.headers.get("retry-after")),
        `Fish TTS 429 (model=${model}, voice=${input.voiceId}): ${errText.slice(0, 500)}`
      );
    }
    throw new Error(
      `Fish TTS ${res.status} (model=${model}, voice=${input.voiceId}): ${errText.slice(0, 500)}`
    );
  }

  return res;
}

async function synthesizeFish(
  input: SynthesizeInput
): Promise<SynthesizeResult> {
  const latency: FishLatency = input.latency ?? "balanced";
  const res = await openFishTtsStream(input, latency);
  const buf = Buffer.from(await res.arrayBuffer());
  const sniffed = sniffAudioContentType(buf);
  return {
    audio: buf,
    contentType: sniffed || "audio/mpeg",
  };
}

/**
 * Open Fish HTTP TTS and hold a live slot. Call this *before* returning a
 * streaming Response so 4xx/5xx from Fish can become JSON instead of HTML /500.
 */
export async function startFishHttpStream(
  input: SynthesizeInput,
  opts?: { latency?: FishLatency }
): Promise<{ response: Response; endLive: () => Promise<void> }> {
  const latency = opts?.latency ?? input.latency ?? "balanced";
  const endLive = await beginLiveFish();
  try {
    const response = await openFishTtsStream(input, latency);
    return { response, endLive };
  } catch (err) {
    await endLive();
    throw err;
  }
}

async function* readFishResponseBody(
  res: Response
): AsyncGenerator<Uint8Array, void, unknown> {
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length) yield new Uint8Array(buf);
    return;
  }

  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Pipe Fish's chunked HTTP TTS response. Yields MP3 bytes as they arrive so
 * browsers can start playback before the clip finishes generating.
 */
export async function* streamFishHttp(
  input: SynthesizeInput,
  opts?: { latency?: FishLatency }
): AsyncGenerator<Uint8Array, void, unknown> {
  const { response, endLive } = await startFishHttpStream(input, opts);
  try {
    yield* readFishResponseBody(response);
  } finally {
    await endLive();
  }
}

async function* streamFish(
  input: SynthesizeInput
): AsyncIterable<Uint8Array> {
  yield* streamFishHttp(input, { latency: "balanced" });
}

export const fishTtsProvider: TtsProviderAdapter = {
  id: "fish",
  synthesize: synthesizeFish,
  synthesizeStream: streamFish,
  streamContentType: () => "audio/mpeg",
};
