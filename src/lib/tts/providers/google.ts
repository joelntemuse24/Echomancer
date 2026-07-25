/**
 * Google Cloud Text-to-Speech (WaveNet / Neural2).
 * Uses REST API with API key or OAuth access token.
 */

import type { SynthesizeInput, SynthesizeResult, TtsProviderAdapter } from "@/lib/tts/types";

function getAccessConfig(): { apiKey?: string; accessToken?: string } {
  const apiKey = process.env.GOOGLE_TTS_API_KEY || process.env.GOOGLE_API_KEY;
  const accessToken = process.env.GOOGLE_TTS_ACCESS_TOKEN;
  return { apiKey, accessToken };
}

function resolveLanguageCode(voiceId: string, language?: string): string {
  // en-US-Wavenet-D → en-US
  const m = voiceId.match(/^([a-z]{2}-[A-Z]{2})/);
  if (m) return m[1]!;
  if (language?.includes("-")) return language;
  return "en-US";
}

async function synthesizeGoogle(input: SynthesizeInput): Promise<SynthesizeResult> {
  const { apiKey, accessToken } = getAccessConfig();
  if (!apiKey && !accessToken) {
    throw new Error("GOOGLE_TTS_API_KEY or GOOGLE_TTS_ACCESS_TOKEN is not configured");
  }

  const languageCode = resolveLanguageCode(input.voiceId, input.language);
  const url = apiKey
    ? `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(apiKey)}`
    : `https://texttospeech.googleapis.com/v1/text:synthesize`;

  const body = {
    input: { text: input.text },
    voice: {
      languageCode,
      name: input.voiceId,
    },
    audioConfig: {
      audioEncoding: "MP3",
      speakingRate: input.speed ?? 1.0,
    },
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (accessToken && !apiKey) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Google TTS ${res.status}: ${errText.slice(0, 400)}`);
  }

  const data = (await res.json()) as { audioContent?: string };
  if (!data.audioContent) {
    throw new Error("Google TTS returned no audioContent");
  }

  return {
    audio: Buffer.from(data.audioContent, "base64"),
    contentType: "audio/mpeg",
  };
}

async function* streamGoogle(input: SynthesizeInput): AsyncIterable<Uint8Array> {
  // Classic Google synthesize is unary — pseudo-stream full buffer
  const result = await synthesizeGoogle(input);
  yield new Uint8Array(result.audio);
}

export const googleTtsProvider: TtsProviderAdapter = {
  id: "google",
  synthesize: synthesizeGoogle,
  synthesizeStream: streamGoogle,
};
