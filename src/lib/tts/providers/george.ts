/**
 * George talks only to the configured Kokoro CPU endpoint, and only if
 * that endpoint says it spoke bm_george. There is no OpenRouter call and
 * no Sowell pack.
 */

import { mapPool } from "@/lib/async-pool";
import type {
  SynthesizeInput,
  SynthesizeResult,
  TtsProviderAdapter,
} from "@/lib/tts/types";
import {
  GEORGE_IN_FLIGHT,
  GEORGE_MAX_CHARS,
  GEORGE_PROVIDER_VOICE_ID,
  georgeEndpoint,
} from "@/lib/tts/george-voice";
import { concatWav, splitSowellText } from "@/lib/tts/providers/sowell";

async function onePiece(
  input: SynthesizeInput,
  text: string,
  url: string
): Promise<Buffer> {
  const token = process.env.GEORGE_TOKEN?.trim() || "";
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "audio/wav",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        text,
        speed: 1,
        voice: GEORGE_PROVIDER_VOICE_ID,
        ...(input.jobId ? { jobId: input.jobId } : {}),
        ...(input.sectionIndex != null ? { sectionIndex: input.sectionIndex } : {}),
      }),
      signal: input.signal,
    });
    if (res.status === 429 && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      continue;
    }
    if (!res.ok) {
      last = await res.text().catch(() => "");
      throw new Error(`George TTS ${res.status}: ${last.slice(0, 300)}`);
    }
    const spoken = res.headers.get("x-kokoro-voice");
    if (spoken !== GEORGE_PROVIDER_VOICE_ID) {
      throw new Error(
        "George endpoint did not confirm bm_george. The audio was not stored."
      );
    }
    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.length < 44) throw new Error("George returned empty audio");
    return audio;
  }
  throw new Error(`George TTS 429: ${last}`);
}

async function synthesizeGeorge(input: SynthesizeInput): Promise<SynthesizeResult> {
  const url = georgeEndpoint();
  const pieces = splitSowellText(input.text, GEORGE_MAX_CHARS);
  if (pieces.length === 0) throw new Error("George received empty text");
  const buffers = await mapPool(pieces, GEORGE_IN_FLIGHT, (piece) =>
    onePiece(input, piece, url)
  );
  return { audio: concatWav(buffers), contentType: "audio/wav" };
}

async function* streamGeorge(input: SynthesizeInput): AsyncIterable<Uint8Array> {
  const result = await synthesizeGeorge(input);
  yield new Uint8Array(result.audio);
}

export const georgeTtsProvider: TtsProviderAdapter = {
  id: "george",
  synthesize: synthesizeGeorge,
  synthesizeStream: streamGeorge,
  streamContentType: "audio/wav",
};
