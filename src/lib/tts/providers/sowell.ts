/**
 * Sowell talks only to the configured endpoint. There is no local model
 * on the take-home VM and no fallback narrator.
 */

import type {
  SynthesizeInput,
  SynthesizeResult,
  TtsProviderAdapter,
} from "@/lib/tts/types";
import { SOWELL_MAX_CHARS, sowellEndpoint } from "@/lib/tts/sowell-voice";

export function splitSowellText(text: string, max = SOWELL_MAX_CHARS): string[] {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  if (cleaned.length <= max) return [cleaned];
  const pieces: string[] = [];
  let rest = cleaned;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = -1;
    const sentence = /[.!?…]["'”’)\]]*\s+/g;
    let match: RegExpExecArray | null;
    while ((match = sentence.exec(window))) cut = match.index + match[0].length;
    if (cut <= 0) {
      const space = window.lastIndexOf(" ");
      cut = space > 40 ? space + 1 : max;
    }
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces.filter(Boolean);
}

async function onePiece(
  input: SynthesizeInput,
  text: string,
  url: string
): Promise<Buffer> {
  const token = process.env.SOWELL_TOKEN?.trim() || "";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "audio/wav",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ text, speed: 1 }),
    signal: input.signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Sowell TTS ${res.status}: ${detail.slice(0, 300)}`);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length < 1000) throw new Error("Sowell returned empty audio");
  return audio;
}

async function synthesizeSowell(input: SynthesizeInput): Promise<SynthesizeResult> {
  const url = sowellEndpoint();
  const pieces = splitSowellText(input.text);
  if (pieces.length === 0) throw new Error("Sowell received empty text");
  const buffers: Buffer[] = [];
  for (const piece of pieces) buffers.push(await onePiece(input, piece, url));
  return { audio: Buffer.concat(buffers), contentType: "audio/wav" };
}

async function* streamSowell(input: SynthesizeInput): AsyncIterable<Uint8Array> {
  const result = await synthesizeSowell(input);
  yield new Uint8Array(result.audio);
}

export const sowellTtsProvider: TtsProviderAdapter = {
  id: "sowell",
  synthesize: synthesizeSowell,
  synthesizeStream: streamSowell,
  streamContentType: "audio/wav",
};
