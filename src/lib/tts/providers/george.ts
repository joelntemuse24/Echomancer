/**
 * George talks only to the configured Kokoro CPU endpoint, and only if
 * that endpoint says it spoke bm_george. There is no OpenRouter call and
 * no Sowell pack.
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
  GEORGE_IN_FLIGHT,
  GEORGE_MAX_CHARS,
  GEORGE_PROVIDER_VOICE_ID,
  georgeEndpoint,
} from "@/lib/tts/george-voice";
import { concatWav, splitSowellText } from "@/lib/tts/providers/sowell";
import { remoteFetch, remoteSectionKey } from "@/lib/remote/http";

async function onePiece(
  input: SynthesizeInput,
  text: string,
  url: string,
  master = false
): Promise<KokoroTake> {
  const token = process.env.GEORGE_TOKEN?.trim() || "";
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
            voice: GEORGE_PROVIDER_VOICE_ID,
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
      throw new Error(`George TTS ${res.status}: ${last.slice(0, 300)}`);
    }
    const spoken = res.headers.get("x-kokoro-voice");
    if (spoken !== GEORGE_PROVIDER_VOICE_ID) {
      throw new Error(
        "George endpoint did not confirm bm_george. The audio was not stored."
      );
    }
    const take = parseKokoroBody(Buffer.from(await res.arrayBuffer()), res.headers);
    const audio = take.wav;
    if (audio.length < 44) throw new Error("George returned empty audio");
    return take;
  }
  throw new Error(`George TTS 429: ${last}`);
}

async function synthesizeGeorge(input: SynthesizeInput): Promise<SynthesizeResult> {
  const url = georgeEndpoint();
  const pieces = splitSowellText(input.text, GEORGE_MAX_CHARS);
  if (pieces.length === 0) throw new Error("George received empty text");
  // A split section is joined here, so only a one-call section can come
  // back mastered; the rest go through the CPU master task as before.
  const master = pieces.length === 1 && kokoroContainerMasterEnabled();
  const takes = await mapPool(pieces, GEORGE_IN_FLIGHT, (piece) =>
    onePiece(input, piece, url, master)
  );
  const mastered = master ? takes[0]?.mastered : undefined;
  return {
    audio: concatWav(takes.map((take) => take.wav)),
    contentType: "audio/wav",
    ...(mastered ? { mastered } : {}),
  };
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
