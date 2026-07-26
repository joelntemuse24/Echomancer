/**
 * OpenRouter unified TTS — OpenAI-compatible /api/v1/audio/speech
 * Docs: https://openrouter.ai/docs/guides/overview/multimodal/tts
 */

import type { SynthesizeInput, SynthesizeResult, TtsProviderAdapter } from "@/lib/tts/types";
import { ensureBrowserPlayable } from "@/lib/tts/pcm-wav";

const BASE = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(
  /\/$/,
  ""
);

export function getOpenRouterApiKey(): string | undefined {
  return (
    process.env.OPENROUTER_API_KEY ||
    process.env.OPEN_ROUTER_API_KEY ||
    undefined
  );
}

function requireKey(): string {
  const key = getOpenRouterApiKey();
  if (!key) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }
  return key;
}

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer":
      process.env.NEXT_PUBLIC_APP_URL || "https://echomancer-v2.vercel.app",
    "X-Title": "Echomancer",
  };
}

/**
 * Gemini TTS via OpenRouter only supports PCM output.
 * Other models default to MP3.
 */
function isGeminiModel(model?: string): boolean {
  return !!model && model.includes("gemini");
}

function responseFormatFor(model: string): string {
  return isGeminiModel(model) ? "pcm" : "mp3";
}

/**
 * Wire format from the API. Gemini returns raw PCM; browsers get WAV
 * via ensureBrowserPlayable (unary) or stream-session (live stream).
 */
function wireContentTypeFor(model: string): string {
  return isGeminiModel(model) ? "audio/pcm" : "audio/mpeg";
}

/**
 * model field on SynthesizeInput carries the OpenRouter model slug
 * (e.g. openai/gpt-4o-mini-tts-2025-12-15). voiceId is the voice name.
 */
async function synthesizeOpenRouter(
  input: SynthesizeInput
): Promise<SynthesizeResult> {
  const apiKey = requireKey();
  const model = input.model;
  if (!model) {
    throw new Error("OpenRouter TTS requires model slug");
  }

  const fmt = responseFormatFor(model);
  const body: Record<string, unknown> = {
    model,
    input: input.text,
    voice: input.voiceId || "alloy",
    response_format: fmt,
  };
  if (input.speed && input.speed !== 1.0) body.speed = input.speed;
  // OpenAI uses `instructions`; Gemini uses `prompt` for style guidance
  if (input.stylePrompt) {
    if (model.startsWith("openai/")) body.instructions = input.stylePrompt;
    else if (isGeminiModel(model)) body.prompt = input.stylePrompt;
  }

  const res = await fetch(`${BASE}/audio/speech`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `OpenRouter TTS ${res.status} (model=${model}, voice=${input.voiceId}): ${errText.slice(0, 500)}`
    );
  }

  const buf = Buffer.from(await res.arrayBuffer());
  // Prefer response header; fall back to expected wire format for this model
  const expectedApi = wireContentTypeFor(model);
  const headerCt = res.headers.get("content-type") || "";
  const normalized = headerCt.includes("wav") ? "audio/wav"
    : headerCt.includes("ogg") ? "audio/ogg"
    : headerCt.includes("pcm") || headerCt.includes("l16") ? "audio/pcm"
    : headerCt.includes("mpeg") ? "audio/mpeg"
    : expectedApi;
  // Gemini (and any raw PCM) → WAV so browsers can play previews / segments
  return ensureBrowserPlayable(buf, normalized);
}

async function* streamOpenRouter(
  input: SynthesizeInput
): AsyncIterable<Uint8Array> {
  const apiKey = requireKey();
  const model = input.model;
  if (!model) throw new Error("OpenRouter TTS requires model slug");

  const fmt = responseFormatFor(model);
  const body: Record<string, unknown> = {
    model,
    input: input.text,
    voice: input.voiceId || "alloy",
    response_format: fmt,
  };
  if (input.speed && input.speed !== 1.0) body.speed = input.speed;
  if (input.stylePrompt) {
    if (model.startsWith("openai/")) body.instructions = input.stylePrompt;
    else if (isGeminiModel(model)) body.prompt = input.stylePrompt;
  }

  const acceptType = isGeminiModel(model) ? "audio/pcm, audio/*" : "audio/mpeg, audio/*";
  const res = await fetch(`${BASE}/audio/speech`, {
    method: "POST",
    headers: {
      ...headers(apiKey),
      Accept: acceptType,
    },
    body: JSON.stringify(body),
    signal: input.signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `OpenRouter TTS stream ${res.status} (model=${model}, voice=${input.voiceId}): ${errText.slice(0, 500)}`
    );
  }

  // Stream raw bytes. stream-session prepends a single WAV header for PCM
  // so multi-window Gemini streams stay continuous for <audio>.
  if (!res.body) {
    yield new Uint8Array(Buffer.from(await res.arrayBuffer()));
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

export const openrouterTtsProvider: TtsProviderAdapter = {
  id: "openrouter",
  synthesize: synthesizeOpenRouter,
  synthesizeStream: streamOpenRouter,
  /** Wire format before stream-session PCM→WAV wrap */
  streamContentType: (model?: string) => wireContentTypeFor(model || ""),
};

export interface OpenRouterSpeechModel {
  id: string;
  name: string;
  description?: string;
  pricing?: { prompt?: string; completion?: string };
  supported_voices?: string[] | null;
  architecture?: {
    modality?: string;
    output_modalities?: string[];
  };
}

let cache: { at: number; models: OpenRouterSpeechModel[] } | null = null;
const CACHE_MS = 10 * 60 * 1000;

/** List TTS models (output_modalities=speech). Cached 10 min. */
export async function listOpenRouterSpeechModels(): Promise<
  OpenRouterSpeechModel[]
> {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return cache.models;
  }

  // Models list is public; key optional but preferred for higher limits
  const apiKey = getOpenRouterApiKey();
  const res = await fetch(`${BASE}/models?output_modalities=speech`, {
    headers: apiKey
      ? { Authorization: `Bearer ${apiKey}` }
      : { Accept: "application/json" },
    next: { revalidate: 600 },
  } as RequestInit);

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`OpenRouter models ${res.status}: ${err.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    data?: OpenRouterSpeechModel[];
  };
  const models = data.data || [];
  cache = { at: Date.now(), models };
  return models;
}
