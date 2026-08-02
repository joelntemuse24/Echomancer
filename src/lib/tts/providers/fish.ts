/**
 * Direct Fish Audio TTS + voice cloning.
 *
 * Cloning requires FISH_API_KEY (native Fish API). Cloned voices must synthesize
 * through this adapter — private reference ids are not available on OpenRouter.
 *
 * Docs: https://docs.fish.audio/features/voice-cloning
 */

import type {
  SynthesizeInput,
  SynthesizeResult,
  TtsProviderAdapter,
} from "@/lib/tts/types";
import { sniffAudioContentType } from "@/lib/tts/pcm-wav";

const FISH_API_BASE = (
  process.env.FISH_API_BASE_URL || "https://api.fish.audio"
).replace(/\/+$/, "");

/** Native Fish model id for the free S2.1 Pro tier. */
export const FISH_NATIVE_FREE_MODEL = "s2.1-pro-free";

export function getFishApiKey(): string | undefined {
  const key =
    process.env.FISH_API_KEY?.trim() ||
    process.env.FISH_AUDIO_API_KEY?.trim();
  return key || undefined;
}

export function isFishConfigured(): boolean {
  return Boolean(getFishApiKey());
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

async function synthesizeFish(
  input: SynthesizeInput
): Promise<SynthesizeResult> {
  const apiKey = requireFishKey();
  const model = input.model?.includes("fish-audio/")
    ? FISH_NATIVE_FREE_MODEL
    : input.model || FISH_NATIVE_FREE_MODEL;

  const body: Record<string, unknown> = {
    text: input.text,
    format: "mp3",
    reference_id: input.voiceId,
  };
  if (input.speed && input.speed !== 1) body.speed = input.speed;

  const res = await fetch(`${FISH_API_BASE}/v1/tts`, {
    method: "POST",
    headers: {
      ...authHeaders(apiKey),
      "Content-Type": "application/json",
      model,
    },
    body: JSON.stringify(body),
    signal: input.signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `Fish TTS ${res.status} (model=${model}, voice=${input.voiceId}): ${errText.slice(0, 500)}`
    );
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const sniffed = sniffAudioContentType(buf);
  return {
    audio: buf,
    contentType: sniffed || "audio/mpeg",
  };
}

async function* streamFish(
  input: SynthesizeInput
): AsyncIterable<Uint8Array> {
  // Fish JSON TTS returns a full body; yield as one chunk (stream-session ok).
  const result = await synthesizeFish(input);
  yield new Uint8Array(result.audio);
}

export const fishTtsProvider: TtsProviderAdapter = {
  id: "fish",
  synthesize: synthesizeFish,
  synthesizeStream: streamFish,
  streamContentType: () => "audio/mpeg",
};
