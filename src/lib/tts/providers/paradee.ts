/**
 * Paradee v1.1 int8 — the self-hosted Echomancer narrator behind
 * `scripts/paradee/server.py`.
 *
 * On the worker the sidecar is reachable at `PARADEE_URL`
 * (http://127.0.0.1:8791). On Vercel the same call is proxied through the
 * worker at `POST /paradee/synthesize`, so the model never leaves the box.
 */

import type {
  SynthesizeInput,
  SynthesizeResult,
  TtsProviderAdapter,
} from "@/lib/tts/types";
import { workerSharedSecret } from "@/worker/auth";

/** Sidecar and section ceilings. The model answers one request at a time. */
const PARADEE_MAX_CHARS = 4000;
const PARADEE_CHUNK_CONCURRENCY = 2;
const DEFAULT_PARADEE_URL = "http://127.0.0.1:8791";

type ParadeeTarget = { url: string; authorization: string | null };

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function paradeeTarget(): ParadeeTarget {
  const local = process.env.PARADEE_URL?.trim();
  if (local) {
    const secret = process.env.PARADEE_SECRET?.trim();
    return {
      url: `${trimSlash(local)}/synthesize`,
      authorization: secret ? `Bearer ${secret}` : null,
    };
  }

  const worker = (
    process.env.TAKEHOME_WORKER_URL ||
    process.env.WORKER_URL ||
    ""
  ).trim();
  if (!worker) {
    throw new Error(
      "Paradee TTS is not configured (set PARADEE_URL or WORKER_URL)."
    );
  }
  const secret = workerSharedSecret();
  if (!secret) {
    throw new Error(
      "Paradee TTS is not configured (WORKER_SECRET is missing)."
    );
  }
  return {
    url: `${trimSlash(worker)}/paradee/synthesize`,
    authorization: `Bearer ${secret}`,
  };
}

async function synthesizePiece(
  input: SynthesizeInput,
  text: string,
  target: ParadeeTarget
): Promise<Buffer> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "audio/mpeg",
  };
  if (target.authorization) headers.Authorization = target.authorization;

  const res = await fetch(target.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text,
      speed: input.speed ?? 1,
      format: "mp3",
    }),
    signal: input.signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Paradee TTS ${res.status}: ${detail.slice(0, 500) || res.statusText}`
    );
  }

  return Buffer.from(await res.arrayBuffer());
}

/**
 * Break text into <=max pieces at sentence ends, keeping the original
 * characters. A run without sentence stops is cut at the last space before
 * the limit so one long paragraph still fits the sidecar ceiling.
 */
export function splitParadeeText(text: string, max = PARADEE_MAX_CHARS): string[] {
  if (text.length <= max) return text.trim() ? [text] : [];

  const pieces: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = -1;
    const sentence = /[.!?…]["'”’)\]]*\s+/g;
    let match: RegExpExecArray | null;
    while ((match = sentence.exec(window))) {
      cut = match.index + match[0].length;
    }
    if (cut <= 0) {
      const space = window.lastIndexOf(" ");
      cut = space > 0 ? space + 1 : max;
    }
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) pieces.push(rest);
  return pieces.filter((piece) => piece.trim());
}

async function synthesizeParadee(
  input: SynthesizeInput
): Promise<SynthesizeResult> {
  const target = paradeeTarget();
  const pieces = splitParadeeText(input.text);

  if (pieces.length <= 1) {
    const audio = await synthesizePiece(input, pieces[0] ?? input.text, target);
    return { audio, contentType: "audio/mpeg" };
  }

  // Two requests at a time; order is restored by index, not completion.
  const buffers = new Array<Buffer>(pieces.length);
  let next = 0;
  const worker = async () => {
    while (next < pieces.length) {
      const index = next++;
      buffers[index] = await synthesizePiece(input, pieces[index]!, target);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(PARADEE_CHUNK_CONCURRENCY, pieces.length) },
      worker
    )
  );

  return { audio: Buffer.concat(buffers), contentType: "audio/mpeg" };
}

/**
 * The sidecar returns a whole MP3, so there is no native stream to relay.
 * Yielding the finished take in one chunk keeps the shared Listen path alive.
 */
async function* streamParadee(
  input: SynthesizeInput
): AsyncIterable<Uint8Array> {
  const result = await synthesizeParadee(input);
  yield new Uint8Array(result.audio);
}

export const paradeeTtsProvider: TtsProviderAdapter = {
  id: "paradee",
  synthesize: synthesizeParadee,
  synthesizeStream: streamParadee,
  streamContentType: "audio/mpeg",
};
