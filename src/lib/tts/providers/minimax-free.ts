/**
 * OpenAI-compatible TTS client for an internal MiniMax Free API proxy
 * (e.g. xiaoY233/MiniMax-Free-API → POST /v1/audio/speech).
 *
 * Only used when research-preview gate + allowlist pass. Tokens stay server-side.
 */

import type {
  SynthesizeInput,
  SynthesizeResult,
  TtsProviderAdapter,
} from "@/lib/tts/types";
import {
  getMinimaxFreeApiBaseUrl,
  getMinimaxFreeApiToken,
  isResearchPreviewConfigured,
  RESEARCH_PROVIDER,
} from "@/lib/tts/research-preview";
import { sniffAudioContentType } from "@/lib/tts/pcm-wav";

function requireConfigured(): { base: string; token: string } {
  if (!isResearchPreviewConfigured()) {
    throw new Error(
      "MiniMax Free API is not configured (set MINIMAX_FREE_API_BASE_URL and MINIMAX_FREE_API_TOKEN)."
    );
  }
  return {
    base: getMinimaxFreeApiBaseUrl(),
    token: getMinimaxFreeApiToken(),
  };
}

async function synthesizeMinimaxFree(
  input: SynthesizeInput
): Promise<SynthesizeResult> {
  const { base, token } = requireConfigured();
  const body = {
    model: input.model || "hailuo",
    input: input.text,
    voice: input.voiceId || "English_CaptivatingStoryteller",
  };

  const res = await fetch(`${base}/v1/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "audio/mpeg, audio/*",
    },
    body: JSON.stringify(body),
    signal: input.signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `Research MiniMax Free TTS ${res.status} (voice=${input.voiceId}): ${errText.slice(0, 500)}`
    );
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const sniffed = sniffAudioContentType(buf);
  const headerCt = res.headers.get("content-type") || "";
  const contentType =
    sniffed ||
    (headerCt.includes("mpeg") || headerCt.includes("mp3")
      ? "audio/mpeg"
      : headerCt.includes("wav")
        ? "audio/wav"
        : "audio/mpeg");

  return { audio: buf, contentType };
}

async function* streamMinimaxFree(
  input: SynthesizeInput
): AsyncIterable<Uint8Array> {
  // Parent free-API speech endpoint returns a full MP3 body; yield as one chunk.
  // stream-session still benefits from the shared empty-audio / retry path.
  const result = await synthesizeMinimaxFree(input);
  yield new Uint8Array(result.audio);
}

export const minimaxFreeTtsProvider: TtsProviderAdapter = {
  id: RESEARCH_PROVIDER,
  synthesize: synthesizeMinimaxFree,
  synthesizeStream: streamMinimaxFree,
  streamContentType: "audio/mpeg",
};
