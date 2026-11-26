/**
 * Drew talks only to the configured Kokoro CPU endpoint, and only if that
 * endpoint says it spoke `drew`. There is no OpenRouter call, no Fish call,
 * and no substitute narrator: a failure surfaces instead of quietly
 * switching voice.
 *
 * The request carries the app's speed. The container multiplies it by
 * `DREW_NATIVE_KOKORO_SPEED` (0.88) once, so 1.0 here is Drew's natural pace.
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
  DREW_IN_FLIGHT,
  DREW_MAX_CHARS,
  DREW_PROVIDER_VOICE_ID,
  drewEndpoint,
  drewProsodyField,
  drewProsodyRulesEnabled,
  drewTakeMismatch,
} from "@/lib/tts/drew-voice";
import { concatWav, splitSowellText } from "@/lib/tts/providers/sowell";
import { remoteFetch, remoteSectionKey } from "@/lib/remote/http";

async function onePiece(
  input: SynthesizeInput,
  text: string,
  url: string,
  master = false
): Promise<KokoroTake> {
  const token = process.env.DREW_TOKEN?.trim() || "";
  // App speed. 1 is natural pace. The container multiplies by 0.88 once.
  const speed =
    typeof input.speed === "number" && Number.isFinite(input.speed) && input.speed > 0
      ? input.speed
      : 1;
  let last = "";
  const prosody = drewProsodyField();
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
            speed,
            voice: DREW_PROVIDER_VOICE_ID,
            // Present only while G is on. An omitted field is the stock
            // forward, and the container does not consult its own env.
            ...(prosody ? { prosody } : {}),
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
      throw new Error(`Drew TTS ${res.status}: ${last.slice(0, 300)}`);
    }
    const spoken = res.headers.get("x-kokoro-voice");
    if (spoken !== DREW_PROVIDER_VOICE_ID) {
      throw new Error(
        "Drew endpoint did not confirm the Drew voice. The audio was not stored."
      );
    }
    // The cache key already moved. Audio from a container that ignored the
    // field would be stored as G and replayed after the real rules ship.
    if (drewProsodyRulesEnabled() && res.headers.get("x-kokoro-prosody") !== "G") {
      throw new Error(
        "Drew endpoint did not apply prosody G. The audio was not stored."
      );
    }
    // The cache key names this worker's runtime and Kokoro speed. A container
    // that is still on 0.88, or on the other graph, must not be stored under it.
    const mismatch = drewTakeMismatch(res.headers, speed);
    if (mismatch) throw new Error(mismatch);
    const take = parseKokoroBody(Buffer.from(await res.arrayBuffer()), res.headers);
    const audio = take.wav;
    if (audio.length < 44) throw new Error("Drew returned empty audio");
    return take;
  }
  throw new Error(`Drew TTS 429: ${last}`);
}

async function synthesizeDrew(input: SynthesizeInput): Promise<SynthesizeResult> {
  const url = drewEndpoint();
  const pieces = splitSowellText(input.text, DREW_MAX_CHARS);
  if (pieces.length === 0) throw new Error("Drew received empty text");
  // A split section is joined here, so only a one-call section can come
  // back mastered; the rest go through the CPU master task as before.
  const master = pieces.length === 1 && kokoroContainerMasterEnabled();
  const takes = await mapPool(pieces, DREW_IN_FLIGHT, (piece) =>
    onePiece(input, piece, url, master)
  );
  const mastered = master ? takes[0]?.mastered : undefined;
  return {
    audio: concatWav(takes.map((take) => take.wav)),
    contentType: "audio/wav",
    ...(mastered ? { mastered } : {}),
  };
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
