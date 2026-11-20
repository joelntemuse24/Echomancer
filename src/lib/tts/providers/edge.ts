/**
 * Server-side Edge stock voices for books already stored as Andrew, Ava,
 * Libby, Ryan, or Michelle. A new request that names Ava or Libby is Heart
 * and does not reach this adapter.
 * No Azure subscription. Used for Whole book, Live Stream, and Live Listen
 * fallback when the browser does not expose the matching neural.
 */

import type {
  SynthesizeInput,
  SynthesizeResult,
  TtsProviderAdapter,
} from "@/lib/tts/types";
import { ANDREW_NEURAL_VOICE_ID } from "@/lib/tts/standard-voice";
import { streamEdgeTts, synthesizeEdgeTts } from "@/lib/tts/edge-tts";

async function synthesizeEdge(input: SynthesizeInput): Promise<SynthesizeResult> {
  const audio = await synthesizeEdgeTts({
    text: input.text,
    voice: input.voiceId || ANDREW_NEURAL_VOICE_ID,
    speed: input.speed,
    language: input.language,
    signal: input.signal,
  });
  return { audio, contentType: "audio/mpeg" };
}

async function* streamEdge(input: SynthesizeInput): AsyncIterable<Uint8Array> {
  yield* streamEdgeTts({
    text: input.text,
    voice: input.voiceId || ANDREW_NEURAL_VOICE_ID,
    speed: input.speed,
    language: input.language,
    signal: input.signal,
  });
}

export const edgeTtsProvider: TtsProviderAdapter = {
  id: "edge",
  synthesize: synthesizeEdge,
  synthesizeStream: streamEdge,
  streamContentType: "audio/mpeg",
};
