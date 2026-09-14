/**
 * Unofficial Microsoft Edge online TTS (Read Aloud family).
 *
 * Same websocket path used by `edge-tts` / `edge-tts-universal`: no Azure
 * Speech key. Microsoft can change or rate-limit this endpoint; treat it as
 * best-effort free infrastructure, not a contractual SLA.
 *
 * ToS: this is an undocumented consumer endpoint. Prefer the official Azure
 * Speech SDK if Microsoft shuts it down. See TECHNICAL_DESIGN.
 */

import { createHash, randomUUID } from "node:crypto";
import { ANDREW_NEURAL_VOICE_ID } from "@/lib/tts/standard-voice";
import { escapeSsmlText, fishPausesToSsmlBody } from "@/lib/tts/ssml-pauses";

export const EDGE_TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
export const EDGE_WSS_URL =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
/** Chromium full build used by current `edge-tts` (Python). `.96` hangs with no turn.end. */
export const EDGE_CHROMIUM_FULL_VERSION = "143.0.3650.75";
export const EDGE_CHROMIUM_MAJOR_VERSION =
  EDGE_CHROMIUM_FULL_VERSION.split(".", 1)[0] || "143";
export const EDGE_SEC_MS_GEC_VERSION = `1-${EDGE_CHROMIUM_FULL_VERSION}`;
export const EDGE_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
export const EDGE_CHROMIUM_UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36` +
  ` (KHTML, like Gecko) Chrome/${EDGE_CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36` +
  ` Edg/${EDGE_CHROMIUM_MAJOR_VERSION}.0.0.0`;
export const EDGE_ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";

/** Windows FILETIME epoch offset (seconds between 1601-01-01 and 1970-01-01). */
export const WIN_EPOCH_SECONDS = 11_644_473_600;
const S_TO_100NS = 10_000_000;
const CLOCK_ROUND_SECONDS = 300;

const AUDIO_DELIM = Buffer.from("Path:audio\r\n");

export type EdgeSocketHandlers = {
  onOpen: () => void;
  onMessage: (data: Buffer | string) => void;
  onError: (err: Error) => void;
  onClose: (code: number, reason: string) => void;
};

export type EdgeSocket = {
  send: (data: string) => void;
  close: () => void;
};

export type OpenEdgeSocket = (
  url: string,
  headers: Record<string, string>,
  handlers: EdgeSocketHandlers
) => EdgeSocket | Promise<EdgeSocket>;

export function generateSecMsGec(opts?: {
  nowMs?: number;
  clockSkewSeconds?: number;
}): string {
  const nowSec =
    (opts?.nowMs ?? Date.now()) / 1000 + (opts?.clockSkewSeconds ?? 0);
  let ticks = nowSec + WIN_EPOCH_SECONDS;
  ticks -= ticks % CLOCK_ROUND_SECONDS;
  const windowsTicks = Math.floor(ticks * S_TO_100NS);
  return createHash("sha256")
    .update(`${windowsTicks}${EDGE_TRUSTED_CLIENT_TOKEN}`, "ascii")
    .digest("hex")
    .toUpperCase();
}

export function escapeEdgeSsmlText(text: string): string {
  return escapeSsmlText(text);
}

export function edgeRateFromSpeed(speed?: number): string {
  if (speed == null || !Number.isFinite(speed) || speed === 1) return "+0%";
  const pct = Math.round((speed - 1) * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

export function buildEdgeSsml(
  text: string,
  voice = ANDREW_NEURAL_VOICE_ID,
  opts?: { rate?: string; lang?: string }
): string {
  const lang = opts?.lang || voice.slice(0, 5) || "en-US";
  const rate = opts?.rate || "+0%";
  const body = fishPausesToSsmlBody(text);
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}">` +
    `<voice name="${voice}">` +
    `<prosody pitch="+0Hz" rate="${rate}" volume="+0%">` +
    `${body}` +
    `</prosody></voice></speak>`
  );
}

export function extractEdgeAudioPayload(data: Buffer): Buffer | null {
  const idx = data.indexOf(AUDIO_DELIM);
  if (idx === -1) return null;
  const audio = data.subarray(idx + AUDIO_DELIM.length);
  return audio.length > 0 ? audio : null;
}

export function isEdgeTurnEnd(message: string): boolean {
  return /Path:\s*turn\.end/i.test(message);
}

function rfc1123Now(date = new Date()): string {
  return date.toUTCString();
}

export function buildEdgeSpeechConfigMessage(outputFormat = EDGE_OUTPUT_FORMAT): string {
  const payload = JSON.stringify({
    context: {
      synthesis: {
        audio: {
          metadataoptions: {
            sentenceBoundaryEnabled: "false",
            wordBoundaryEnabled: "false",
          },
          outputFormat,
        },
      },
    },
  });
  return (
    `X-Timestamp:${rfc1123Now()}\r\n` +
    `Content-Type:application/json; charset=utf-8\r\n` +
    `Path:speech.config\r\n\r\n` +
    payload
  );
}

export function buildEdgeSsmlMessage(ssml: string, requestId: string): string {
  return (
    `X-RequestId:${requestId}\r\n` +
    `Content-Type:application/ssml+xml\r\n` +
    `X-Timestamp:${rfc1123Now()}\r\n` +
    `Path:ssml\r\n\r\n` +
    ssml
  );
}

export function edgeRequestHeaders(
  muid = randomUUID().replace(/-/g, "").toUpperCase()
): Record<string, string> {
  return {
    "User-Agent": EDGE_CHROMIUM_UA,
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,en;q=0.9",
    Origin: EDGE_ORIGIN,
    Pragma: "no-cache",
    "Cache-Control": "no-cache",
    Cookie: `muid=${muid};`,
  };
}

export function edgeWebsocketUrl(opts?: {
  nowMs?: number;
  clockSkewSeconds?: number;
  connectionId?: string;
}): string {
  const connectionId = (
    opts?.connectionId || randomUUID().replace(/-/g, "")
  ).toLowerCase();
  const gec = generateSecMsGec({
    nowMs: opts?.nowMs,
    clockSkewSeconds: opts?.clockSkewSeconds,
  });
  // Query order matches current edge-tts: token, ConnectionId, GEC, GEC-Version.
  const params = new URLSearchParams();
  params.set("TrustedClientToken", EDGE_TRUSTED_CLIENT_TOKEN);
  params.set("ConnectionId", connectionId);
  params.set("Sec-MS-GEC", gec);
  params.set("Sec-MS-GEC-Version", EDGE_SEC_MS_GEC_VERSION);
  return `${EDGE_WSS_URL}?${params.toString()}`;
}

async function openDefaultEdgeSocket(
  url: string,
  headers: Record<string, string>,
  handlers: EdgeSocketHandlers
): Promise<EdgeSocket> {
  const { default: WebSocket } = await import("ws");
  const socket = new WebSocket(url, { headers, handshakeTimeout: 15_000 });
  socket.binaryType = "arraybuffer";
  socket.on("open", () => handlers.onOpen());
  // `ws` emits text frames as Buffer with isBinary=false. If we treat those as
  // audio we drop Path:turn.end and hang until the Vercel timeout.
  socket.on("message", (data, isBinary) => {
    if (!isBinary) {
      const text =
        typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : Buffer.from(
                data instanceof ArrayBuffer ? new Uint8Array(data) : String(data)
              ).toString("utf8");
      handlers.onMessage(text);
      return;
    }
    if (Buffer.isBuffer(data)) {
      handlers.onMessage(data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      handlers.onMessage(Buffer.from(new Uint8Array(data)));
      return;
    }
    if (Array.isArray(data)) {
      handlers.onMessage(Buffer.concat(data));
      return;
    }
    handlers.onMessage(String(data));
  });
  socket.on("error", (err) => {
    handlers.onError(err instanceof Error ? err : new Error(String(err)));
  });
  socket.on("close", (code, reason) => {
    handlers.onClose(code, reason.toString());
  });
  return {
    send: (payload) => socket.send(payload),
    close: () => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    },
  };
}

export async function synthesizeEdgeTts(opts: {
  text: string;
  voice?: string;
  speed?: number;
  language?: string;
  signal?: AbortSignal;
  openSocket?: OpenEdgeSocket;
  clockSkewSeconds?: number;
}): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of streamEdgeTts(opts)) {
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    throw new Error("Edge TTS returned no audio");
  }
  return Buffer.concat(chunks);
}

export async function* streamEdgeTts(opts: {
  text: string;
  voice?: string;
  speed?: number;
  language?: string;
  signal?: AbortSignal;
  openSocket?: OpenEdgeSocket;
  clockSkewSeconds?: number;
}): AsyncGenerator<Uint8Array, void, unknown> {
  const text = opts.text.trim();
  if (!text) {
    throw new Error("Edge TTS requires text");
  }
  if (opts.signal?.aborted) {
    throw new Error("Edge TTS aborted");
  }

  const voice = opts.voice || ANDREW_NEURAL_VOICE_ID;
  const ssml = buildEdgeSsml(text, voice, {
    rate: edgeRateFromSpeed(opts.speed),
    lang: opts.language,
  });
  const requestId = randomUUID().replace(/-/g, "");
  const url = edgeWebsocketUrl({ clockSkewSeconds: opts.clockSkewSeconds });
  const headers = edgeRequestHeaders();

  const queue: Array<Uint8Array | Error | "end"> = [];
  let notify: (() => void) | null = null;
  const wake = () => {
    notify?.();
    notify = null;
  };
  const push = (item: Uint8Array | Error | "end") => {
    queue.push(item);
    wake();
  };

  let socket: EdgeSocket | null = null;
  const onAbort = () => {
    socket?.close();
    push(new Error("Edge TTS aborted"));
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const opener = opts.openSocket ?? openDefaultEdgeSocket;
    let opened = false;
    const maybeSocket = opener(url, headers, {
      onOpen: () => {
        opened = true;
        socket?.send(buildEdgeSpeechConfigMessage());
        socket?.send(buildEdgeSsmlMessage(ssml, requestId));
      },
      onMessage: (data) => {
        if (typeof data === "string") {
          if (isEdgeTurnEnd(data)) push("end");
          return;
        }
        // Defense: injected / misclassified text frames still end the turn.
        if (isEdgeTurnEnd(data.subarray(0, 256).toString("utf8"))) {
          push("end");
          return;
        }
        const audio = extractEdgeAudioPayload(data);
        if (audio) push(new Uint8Array(audio));
      },
      onError: (err) => push(err),
      onClose: (code, reason) => {
        if (!opened && code && code !== 1000) {
          push(
            new Error(
              `Edge TTS handshake failed (${code}): ${reason || "no reason"}`
            )
          );
          return;
        }
        if (code && code !== 1000 && code !== 1005) {
          push(new Error(`Edge TTS socket closed (${code}): ${reason}`));
          return;
        }
        push("end");
      },
    });
    // Don't `await` a sync factory — that yields a microtask and onOpen
    // would run before `socket` is assigned.
    socket =
      maybeSocket && typeof (maybeSocket as Promise<EdgeSocket>).then === "function"
        ? await maybeSocket
        : (maybeSocket as EdgeSocket);
    if (opened) {
      // onOpen ran before assignment (sync factory) — send now.
      socket.send(buildEdgeSpeechConfigMessage());
      socket.send(buildEdgeSsmlMessage(ssml, requestId));
    }

    let gotAudio = false;
    while (true) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
      const next = queue.shift();
      if (next === undefined) continue;
      if (next === "end") break;
      if (next instanceof Error) throw next;
      gotAudio = true;
      yield next;
    }
    if (!gotAudio) {
      throw new Error("Edge TTS returned no audio");
    }
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    socket?.close();
  }
}
