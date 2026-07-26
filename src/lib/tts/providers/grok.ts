/**
 * xAI Grok Text-to-Speech API.
 * Docs: https://docs.x.ai — TTS ~$15/1M chars, streaming via response body / websocket.
 */

import type { SynthesizeInput, SynthesizeResult, TtsProviderAdapter } from "@/lib/tts/types";

const XAI_TTS_URL = process.env.XAI_TTS_URL || "https://api.x.ai/v1/tts";

function getApiKey(): string {
  const key = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  if (!key) throw new Error("XAI_API_KEY is not configured");
  return key;
}

async function synthesizeGrok(input: SynthesizeInput): Promise<SynthesizeResult> {
  const apiKey = getApiKey();

  const res = await fetch(XAI_TTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: input.text,
      voice: input.voiceId || "Eve",
      format: "mp3",
      language: input.language || "en",
    }),
    signal: input.signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Grok TTS ${res.status}: ${errText.slice(0, 400)}`);
  }

  const contentType = res.headers.get("content-type") || "audio/mpeg";
  const arrayBuffer = await res.arrayBuffer();
  return {
    audio: Buffer.from(arrayBuffer),
    contentType: contentType.includes("wav") ? "audio/wav" : "audio/mpeg",
  };
}

async function* streamGrok(input: SynthesizeInput): AsyncIterable<Uint8Array> {
  const apiKey = getApiKey();

  const res = await fetch(XAI_TTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "audio/mpeg, audio/*",
    },
    body: JSON.stringify({
      text: input.text,
      voice: input.voiceId || "Eve",
      format: "mp3",
      language: input.language || "en",
      stream: true,
    }),
    signal: input.signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Grok TTS stream ${res.status}: ${errText.slice(0, 400)}`);
  }

  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    yield new Uint8Array(buf);
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

export const grokTtsProvider: TtsProviderAdapter = {
  id: "grok",
  synthesize: synthesizeGrok,
  synthesizeStream: streamGrok,
  streamContentType: "audio/mpeg",
};
