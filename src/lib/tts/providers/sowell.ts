/**
 * Sowell talks only to the configured endpoint. There is no local model
 * on the take-home VM and no fallback narrator.
 *
 * Pieces of one call run at most two at a time, which is the container
 * cap, and are concatenated in request order. A 429 is the busy container
 * and is retried so the other container can take it. A hard error throws
 * before any audio is returned.
 */

import { mapPool } from "@/lib/async-pool";
import type {
  SynthesizeInput,
  SynthesizeResult,
  TtsProviderAdapter,
} from "@/lib/tts/types";
import {
  SOWELL_IN_FLIGHT,
  SOWELL_MAX_CHARS,
  sowellEndpoint,
} from "@/lib/tts/sowell-voice";

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

/** Join 16-bit mono WAV parts. Sample rates must match. */
export function concatWav(parts: Buffer[]): Buffer {
  if (parts.length === 0) throw new Error("Sowell returned no audio");
  if (parts.length === 1) return parts[0]!;
  let rate = 0;
  const frames: Buffer[] = [];
  for (const part of parts) {
    if (part.toString("ascii", 0, 4) !== "RIFF" || part.toString("ascii", 8, 12) !== "WAVE") {
      throw new Error("Sowell returned a non-wav body");
    }
    if (part.readUInt16LE(22) !== 1 || part.readUInt16LE(34) !== 16) {
      throw new Error("Sowell wav is not 16-bit mono");
    }
    const sampleRate = part.readUInt32LE(24);
    if (rate === 0) rate = sampleRate;
    else if (rate !== sampleRate) throw new Error("Sowell wav sample rates differ");
    const dataAt = part.indexOf("data");
    if (dataAt < 0 || dataAt + 8 > part.length) throw new Error("Sowell wav has no data");
    const size = part.readUInt32LE(dataAt + 4);
    frames.push(part.subarray(dataAt + 8, dataAt + 8 + size));
  }
  const pcm = Buffer.concat(frames);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function onePiece(
  input: SynthesizeInput,
  text: string,
  url: string
): Promise<Buffer> {
  const token = process.env.SOWELL_TOKEN?.trim() || "";
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
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
    if (res.status === 429 && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      continue;
    }
    if (!res.ok) {
      last = await res.text().catch(() => "");
      throw new Error(`Sowell TTS ${res.status}: ${last.slice(0, 300)}`);
    }
    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.length < 44) throw new Error("Sowell returned empty audio");
    return audio;
  }
  throw new Error(`Sowell TTS 429: ${last}`);
}

async function synthesizeSowell(input: SynthesizeInput): Promise<SynthesizeResult> {
  const url = sowellEndpoint();
  const pieces = splitSowellText(input.text);
  if (pieces.length === 0) throw new Error("Sowell received empty text");
  const buffers = await mapPool(pieces, SOWELL_IN_FLIGHT, (piece) =>
    onePiece(input, piece, url)
  );
  return { audio: concatWav(buffers), contentType: "audio/wav" };
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
