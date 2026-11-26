/**
 * Heart talks only to the configured Kokoro CPU endpoint, and only if
 * that endpoint says it spoke af_heart. There is no OpenRouter call, no
 * Drew checkpoint, and no Sowell pack.
 */

import {
  type KokoroTake,
  kokoroContainerMasterEnabled,
  kokoroMasterRecipe,
  parseKokoroBody,
} from "@/lib/tts/kokoro-master";
import { mapPool } from "@/lib/async-pool";
import type {
  SynthesizeInput,
  SynthesizeResult,
  TtsProviderAdapter,
} from "@/lib/tts/types";
import {
  HEART_IN_FLIGHT,
  HEART_MAX_CHARS,
  HEART_PROVIDER_VOICE_ID,
  heartEndpoint,
} from "@/lib/tts/heart-voice";
import { concatWav, splitSowellText } from "@/lib/tts/providers/sowell";
import { remoteFetch, remoteSectionKey } from "@/lib/remote/http";

async function onePiece(
  input: SynthesizeInput,
  text: string,
  url: string,
  master = false
): Promise<KokoroTake> {
  const token = process.env.HEART_TOKEN?.trim() || "";
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await remoteFetch({
        provider: "kokoro",
        jobId: input.jobId,
        section: remoteSectionKey(input.sectionIndex, text),
        estCostUsd: 0.01,
        url,
        init: {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "audio/wav",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            text,
            speed: 1,
            voice: HEART_PROVIDER_VOICE_ID,
            // The container masters this take too (one section, one call).
            ...(master ? { master: kokoroMasterRecipe() } : {}),
            ...(input.jobId ? { jobId: input.jobId } : {}),
            ...(input.sectionIndex != null ? { sectionIndex: input.sectionIndex } : {}),
          }),
          signal: input.signal,
        },
      });
    if (res.status === 429 && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      continue;
    }
    if (!res.ok) {
      last = await res.text().catch(() => "");
      throw new Error(`Heart TTS ${res.status}: ${last.slice(0, 300)}`);
    }
    const spoken = res.headers.get("x-kokoro-voice");
    if (spoken !== HEART_PROVIDER_VOICE_ID) {
      throw new Error(
        "Heart endpoint did not confirm af_heart. The audio was not stored."
      );
    }
    const take = parseKokoroBody(Buffer.from(await res.arrayBuffer()), res.headers);
    const audio = take.wav;
    if (audio.length < 44) throw new Error("Heart returned empty audio");
    return take;
  }
  throw new Error(`Heart TTS 429: ${last}`);
}

async function synthesizeHeart(input: SynthesizeInput): Promise<SynthesizeResult> {
  const url = heartEndpoint();
  const pieces = splitSowellText(input.text, HEART_MAX_CHARS);
  if (pieces.length === 0) throw new Error("Heart received empty text");
  // A split section is joined here, so only a one-call section can come
  // back mastered; the rest go through the CPU master task as before.
  const master = pieces.length === 1 && kokoroContainerMasterEnabled();
  const takes = await mapPool(pieces, HEART_IN_FLIGHT, (piece) =>
    onePiece(input, piece, url, master)
  );
  const mastered = master ? takes[0]?.mastered : undefined;
  return {
    audio: concatWav(takes.map((take) => take.wav)),
    contentType: "audio/wav",
    ...(mastered ? { mastered } : {}),
  };
}

async function* streamHeart(input: SynthesizeInput): AsyncIterable<Uint8Array> {
  const result = await synthesizeHeart(input);
  yield new Uint8Array(result.audio);
}

export const heartTtsProvider: TtsProviderAdapter = {
  id: "heart",
  synthesize: synthesizeHeart,
  synthesizeStream: streamHeart,
  streamContentType: "audio/wav",
};
