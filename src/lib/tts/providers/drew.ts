/**
 * Drew talks only to the configured Kokoro CPU endpoint, and only if that
 * endpoint says it spoke `drew`. There is no OpenRouter call, no Fish call,
 * and no substitute narrator: a failure surfaces instead of quietly
 * switching voice.
 *
 * The request carries the app's speed. The container multiplies it by
 * `DREW_NATIVE_KOKORO_SPEED` (0.88), so 1.0 here is Drew's natural pace.
 */

import { mapPool } from "@/lib/async-pool";
import type {
  SynthesizeInput,
  SynthesizeResult,
  TtsProviderAdapter,
} from "@/lib/tts/types";
import {
  DREW_IN_FLIGHT,
  DREW_MAX_CHARS,
  DREW_PROVIDER_VOICE_ID,
  drewEndpoint,
} from "@/lib/tts/drew-voice";
import { concatWav, splitSowellText } from "@/lib/tts/providers/sowell";

async function onePiece(
  input: SynthesizeInput,
  text: string,
  url: string
): Promise<Buffer> {
  const token = process.env.DREW_TOKEN?.trim() || "";
  // App speed. 1 is Drew's native pace (0.88 Kokoro speed).
  const speed =
    typeof input.speed === "number" && Number.isFinite(input.speed) && input.speed > 0
      ? input.speed
      : 1;
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
        speed,
        voice: DREW_PROVIDER_VOICE_ID,
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
      throw new Error(`Drew TTS ${res.status}: ${last.slice(0, 300)}`);
    }
    const spoken = res.headers.get("x-kokoro-voice");
    if (spoken !== DREW_PROVIDER_VOICE_ID) {
      throw new Error(
        "Drew endpoint did not confirm the Drew voice. The audio was not stored."
      );
    }
    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.length < 44) throw new Error("Drew returned empty audio");
    return audio;
  }
  throw new Error(`Drew TTS 429: ${last}`);
}

async function synthesizeDrew(input: SynthesizeInput): Promise<SynthesizeResult> {
  const url = drewEndpoint();
  const pieces = splitSowellText(input.text, DREW_MAX_CHARS);
  if (pieces.length === 0) throw new Error("Drew received empty text");
  const buffers = await mapPool(pieces, DREW_IN_FLIGHT, (piece) =>
    onePiece(input, piece, url)
  );
  return { audio: concatWav(buffers), contentType: "audio/wav" };
}

async function* streamDrew(input: SynthesizeInput): AsyncIterable<Uint8Array> {
  const result = await synthesizeDrew(input);
  yield new Uint8Array(result.audio);
}

export const drewTtsProvider: TtsProviderAdapter = {
  id: "drew",
  synthesize: synthesizeDrew,
  synthesizeStream: streamDrew,
  streamContentType: "audio/wav",
};
