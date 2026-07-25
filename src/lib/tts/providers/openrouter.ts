/**
 * OpenRouter unified TTS — OpenAI-compatible /api/v1/audio/speech
 * Docs: https://openrouter.ai/docs/guides/overview/multimodal/tts
 */

import type { SynthesizeInput, SynthesizeResult, TtsProviderAdapter } from "@/lib/tts/types";

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

  const body: Record<string, unknown> = {
    model,
    input: input.text,
    voice: input.voiceId || "alloy",
    response_format: "mp3",
  };
  if (input.speed && input.speed !== 1.0) body.speed = input.speed;
  if (input.stylePrompt) body.instructions = input.stylePrompt;

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

  const contentType = res.headers.get("content-type") || "audio/mpeg";
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    audio: buf,
    contentType: contentType.includes("pcm") ? "audio/pcm" : "audio/mpeg",
  };
}

async function* streamOpenRouter(
  input: SynthesizeInput
): AsyncIterable<Uint8Array> {
  const apiKey = requireKey();
  const model = input.model;
  if (!model) throw new Error("OpenRouter TTS requires model slug");

  const body: Record<string, unknown> = {
    model,
    input: input.text,
    voice: input.voiceId || "alloy",
    response_format: "mp3",
  };
  if (input.speed && input.speed !== 1.0) body.speed = input.speed;
  if (input.stylePrompt) body.instructions = input.stylePrompt;

  const res = await fetch(`${BASE}/audio/speech`, {
    method: "POST",
    headers: {
      ...headers(apiKey),
      Accept: "audio/mpeg, audio/*",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `OpenRouter TTS stream ${res.status} (model=${model}, voice=${input.voiceId}): ${errText.slice(0, 500)}`
    );
  }

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
