/**
 * Gemini 2.5 Flash TTS via Google Gemini API / Cloud TTS Gemini path.
 * Billing is primarily audio-token based (~$0.90/audio-hour for 2.5 Flash).
 */

import type { SynthesizeInput, SynthesizeResult, TtsProviderAdapter } from "@/lib/tts/types";

const DEFAULT_MODEL = "gemini-2.5-flash-tts";

function getApiKey(): string {
  const key =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_AI_API_KEY ||
    process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY (or GOOGLE_API_KEY) is not configured");
  return key;
}

function modelName(input: SynthesizeInput): string {
  return input.model || process.env.GEMINI_TTS_MODEL || DEFAULT_MODEL;
}

/**
 * Call Gemini TTS generateContent-style endpoint.
 * Response shape varies; we accept inline base64 audio parts.
 */
async function synthesizeGemini(input: SynthesizeInput): Promise<SynthesizeResult> {
  const apiKey = getApiKey();
  const model = modelName(input);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const style =
    input.stylePrompt ||
    "Read this as a clear, engaging audiobook narrator with natural pacing.";

  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: `${style}\n\n${input.text}` }],
      },
    ],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: input.voiceId || "Kore",
          },
        },
      },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: input.signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini TTS ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          inlineData?: { mimeType?: string; data?: string };
          inline_data?: { mime_type?: string; data?: string };
        }>;
      };
    }>;
  };

  const part = data.candidates?.[0]?.content?.parts?.find(
    (p) => p.inlineData?.data || p.inline_data?.data
  );
  const b64 = part?.inlineData?.data || part?.inline_data?.data;
  const mime =
    part?.inlineData?.mimeType ||
    part?.inline_data?.mime_type ||
    "audio/mpeg";

  if (!b64) {
    throw new Error("Gemini TTS returned no audio data");
  }

  return {
    audio: Buffer.from(b64, "base64"),
    contentType: mime.includes("wav")
      ? "audio/wav"
      : mime.includes("ogg")
        ? "audio/ogg"
        : "audio/mpeg",
  };
}

async function* streamGemini(input: SynthesizeInput): AsyncIterable<Uint8Array> {
  // Unary audio for now — yield full buffer (still low latency per window)
  const result = await synthesizeGemini(input);
  yield new Uint8Array(result.audio);
}

export const geminiTtsProvider: TtsProviderAdapter = {
  id: "gemini",
  synthesize: synthesizeGemini,
  synthesizeStream: streamGemini,
  streamContentType: "audio/mpeg",
};
