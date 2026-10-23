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

import { randomUUID } from "node:crypto";
import { ANDREW_NEURAL_VOICE_ID } from "@/lib/tts/standard-voice";
import { createInFlightGate } from "@/lib/tts/section-concurrency";
import {
  escapeSsmlText,
  fishPausesToEdgeProsodyText,
} from "@/lib/tts/ssml-pauses";

export const EDGE_TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
export const EDGE_WSS_URL =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
/** Chromium full build used by current `edge-tts` (Python). `.96` hangs with no turn.end. */
export const EDGE_CHROMIUM_FULL_VERSION = "143.0.3650.75";
export const EDGE_CHROMIUM_MAJOR_VERSION =
  EDGE_CHROMIUM_FULL_VERSION.split(".", 1)[0] || "143";
export const EDGE_SEC_MS_GEC_VERSION = `2-${EDGE_CHROMIUM_FULL_VERSION}`;
/** Higher spoken-word MP3. Refused formats fall back to {@link EDGE_OUTPUT_FORMAT_COMPAT}. */
export const EDGE_OUTPUT_FORMAT_HIGH = "audio-24khz-96kbitrate-mono-mp3";
/** Format this endpoint has accepted. Used when the higher one is refused. */
export const EDGE_OUTPUT_FORMAT_COMPAT = "audio-24khz-48kbitrate-mono-mp3";
export const EDGE_OUTPUT_FORMAT = EDGE_OUTPUT_FORMAT_HIGH;
export const EDGE_CHROMIUM_UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36` +
  ` (KHTML, like Gecko) Chrome/${EDGE_CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36` +
  ` Edg/${EDGE_CHROMIUM_MAJOR_VERSION}.0.0.0`;
export const EDGE_ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
/**
 * No websocket frame for this long ends the turn. The handshake timeout does
 * not cover a socket that opened, sent audio, then went quiet.
 */
export const EDGE_INACTIVITY_MS = 25_000;
const EDGE_STREAM_FLOOR_MS = 45_000;
/** A 4,000-character section already takes 125–150s in a real batch. */
const EDGE_STREAM_CEILING_MS = 300_000;

/**
 * Wall clock for one Edge turn. Speech is about 15 characters a second;
 * allow four times that, and keep the wait between 45 seconds and 5 minutes.
 */
export function edgeStreamBudgetMs(charCount: number): number {
  const chars = Number.isFinite(charCount) && charCount > 0 ? charCount : 0;
  const scaled = Math.ceil(chars / 15) * 4_000;
  return Math.min(EDGE_STREAM_CEILING_MS, Math.max(EDGE_STREAM_FLOOR_MS, scaled));
}

/**
 * Whole sections are split into these chunks before synthesis. One 4,000-
 * character turn streams for 130–180 seconds and, when it dies at 1006, the
 * retry repeats all of it. Chunks are small enough to finish fast and to
 * retry cheaply.
 */
export const EDGE_CHUNK_TARGET_CHARS = 1200;
/** Boundaries nearer than this are skipped so chunks stay near the target. */
export const EDGE_CHUNK_MIN_CHARS = 1000;
export const EDGE_CHUNK_MAX_CHARS = 1500;
/** Chunks of one section synthesized at once. */
export const EDGE_CHUNK_CONCURRENCY = 4;
/** A chunk that sends no frame for this long is abandoned. */
export const EDGE_CHUNK_INACTIVITY_MS = 10_000;
export const EDGE_CHUNK_ATTEMPTS = 3;
export const EDGE_CHUNK_BACKOFF_MS = 500;
export const EDGE_CHUNK_TOTAL_CEILING_MS = 90_000;
export const EDGE_CHUNK_TOTAL_FLOOR_MS = 15_000;

/**
 * Wall clock for one chunk. Speech runs near 15 characters a second, so
 * allow 1.5× that, floored for a short tail chunk and capped at 90 seconds.
 */
export function edgeChunkBudgetMs(charCount: number): number {
  const chars = Number.isFinite(charCount) && charCount > 0 ? charCount : 0;
  const scaled = Math.ceil(chars / 15) * 1_500;
  return Math.min(
    EDGE_CHUNK_TOTAL_CEILING_MS,
    Math.max(EDGE_CHUNK_TOTAL_FLOOR_MS, scaled)
  );
}

/** Websockets this process may hold open across every Edge section. */
export const EDGE_SOCKET_CONCURRENCY_DEFAULT = 32;
export const EDGE_SOCKET_CONCURRENCY_MAX = 64;

export function edgeSocketConcurrency(): number {
  const raw = Number(process.env.TTS_EDGE_SOCKET_CONCURRENCY);
  const chosen =
    Number.isFinite(raw) && raw > 0
      ? Math.floor(raw)
      : EDGE_SOCKET_CONCURRENCY_DEFAULT;
  return Math.max(1, Math.min(EDGE_SOCKET_CONCURRENCY_MAX, chosen));
}

let edgeSocketGate: ReturnType<typeof createInFlightGate> | null = null;

/** Shared gate so section fan-out × chunk fan-out cannot open unlimited sockets. */
function edgeSocketSlot(): ReturnType<typeof createInFlightGate> {
  if (!edgeSocketGate) {
    edgeSocketGate = createInFlightGate(edgeSocketConcurrency());
  }
  return edgeSocketGate;
}

/** Test hook: forget the gate so a new env value is picked up. */
export function resetEdgeSocketGate(): void {
  edgeSocketGate = null;
}

function lastBoundaryAt(window: string, re: RegExp, min: number): number {
  let cut = -1;
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(window))) {
    const end = match.index + match[0].length;
    if (match[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    if (end >= min && end <= window.length) cut = end;
  }
  return cut;
}

/**
 * Split section text into Edge-sized chunks, preferring paragraph and then
 * sentence boundaries. `chunks.join("")` is the trimmed input, so no words
 * are dropped and the spoken text is unchanged.
 */
export function splitEdgeText(
  text: string,
  opts?: { minChars?: number; maxChars?: number }
): string[] {
  const source = text.trim();
  if (!source) return [];
  const min = Math.max(1, Math.floor(opts?.minChars ?? EDGE_CHUNK_MIN_CHARS));
  const max = Math.max(min, Math.floor(opts?.maxChars ?? EDGE_CHUNK_MAX_CHARS));
  if (source.length <= max) return [source];

  const chunks: string[] = [];
  let rest = source;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = lastBoundaryAt(window, /\n\s*\n/g, min);
    if (cut < 0) cut = lastBoundaryAt(window, /[.!?…]["'”’)\]]?\s+/g, min);
    if (cut < 0) cut = lastBoundaryAt(window, /\s+/g, min);
    // A single unbroken token longer than the window: hard split.
    if (cut < 0) cut = window.length;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) chunks.push(rest);
  return chunks;
}

/**
 * Windows FILETIME epoch offset (seconds between 1601-01-01 and 1970-01-01).
 */
export const WIN_EPOCH_SECONDS = 11_644_473_600;
const S_TO_100NS = 10_000_000;
const CLOCK_ROUND_SECONDS = 300;

/**
 * Token digest tables from `edge-tts` 7.3.1 `drm.py`. Microsoft's v2
 * Sec-MS-GEC is a SHA-256 variant with its initial state, schedule prefix and
 * one round constant pre-adjusted, plus a CS64 digest over the same bytes.
 * These values are part of the protocol, so keep them verbatim.
 */
const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
] as const;
const SHA256_STATE = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab,
  0xfeb0a7e4, 0x03effbd2,
] as const;
const SHA256_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491,
  0xc0dd25a0, 0xf9e70ab6, 0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33,
  0xd258b060, 0x72766564,
] as const;
const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;
const SHA256_ADJUSTMENT = 0xc9dc06a7;
const SHA256_BLOCK_CONSTANTS = [
  ...SHA256_ROUND_CONSTANTS.slice(0, 14),
  SHA256_ADJUSTMENT,
  ...SHA256_ROUND_CONSTANTS.slice(15),
] as const;
const SHA256_SIGMA0_ADJUSTMENT = 0x059c0b80;
const SHA256_SIGMA1_ADJUSTMENT = 0x000b92c0;

const CS64_COEFFICIENTS = [
  [0xe82e91b1, 0xb32700d0],
  [0x44de24c6, 0x88dff51d],
  [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5],
  [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6],
  [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464],
  [0xbed20560, 0x3c3c74f3],
  [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1],
  [0xcb49e3c6, 0xc5626167],
] as const;
const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xf2f90b1a;
const CS64_ADJUSTMENT1 = 0x0b1a0000;

/** 32-bit rotate left by 16 bits. */
function rol16(value: number): number {
  const v = value >>> 0;
  return ((v << 16) | (v >>> 16)) >>> 0;
}

function rotr(value: number, bits: number): number {
  const v = value >>> 0;
  return ((v >>> bits) | (v << (32 - bits))) >>> 0;
}

function mul32(a: number, b: number): number {
  return Math.imul(a, b) >>> 0;
}

function add32(...values: number[]): number {
  let sum = 0;
  for (const value of values) sum = (sum + (value >>> 0)) >>> 0;
  return sum;
}

/** Real modulo; JavaScript `%` keeps the sign of the dividend. */
function positiveMod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

/** SHA-256 small sigma zero, truncating the combined rotations once. */
function sigma0(value: number): number {
  const v = value >>> 0;
  return ((v >>> 7) ^ (v << 25) ^ (v >>> 18) ^ (v << 14) ^ (v >>> 3)) >>> 0;
}

/** SHA-256 small sigma one, truncating the combined rotations once. */
function sigma1(value: number): number {
  const v = value >>> 0;
  return ((v >>> 17) ^ (v << 15) ^ (v >>> 19) ^ (v << 13) ^ (v >>> 10)) >>> 0;
}

/** Split data into little-endian 32-bit words, zero-padded to an even count. */
function wordsLe4Even(data: Buffer): number[] {
  const padded = Buffer.alloc(data.length + (positiveMod(-data.length, 4)));
  data.copy(padded, 0);
  const words: number[] = [];
  for (let offset = 0; offset < padded.length; offset += 4) {
    words.push(padded.readUInt32LE(offset));
  }
  if (words.length % 2) words.push(0);
  return words;
}

/** Run SHA-256 rounds, optionally resuming inside the first block. */
function sha256Rounds(
  state: readonly number[],
  words: readonly number[],
  firstRound = 0
): number[] {
  let a = state[0]!;
  let b = state[1]!;
  let c = state[2]!;
  let d = state[3]!;
  let e = state[4]!;
  let f = state[5]!;
  let g = state[6]!;
  let h = state[7]!;
  const constants =
    firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;
  for (let index = firstRound; index < 64; index++) {
    const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const choose = g ^ (e & (f ^ g));
    const t1 = add32(h, s1, choose, constants[index]!, words[index]!);
    const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const majority = (a & b) | (c & (a | b));
    const t2 = add32(s0, majority);
    h = g;
    g = f;
    f = e;
    e = add32(d, t1);
    d = c;
    c = b;
    b = a;
    a = add32(t1, t2);
  }
  return [a, b, c, d, e, f, g, h];
}

/** Expand SHA-256 words, combining rotations before modular addition. */
function expandSha256Schedule(words: number[], firstWord = 16): void {
  for (let index = firstWord; index < 64; index++) {
    const x = words[index - 2]!;
    const y = words[index - 15]!;
    words.push(
      add32(sigma1(x), words[index - 7]!, sigma0(y), words[index - 16]!)
    );
  }
}

/** Compute the initial SHA-256 state for token data. */
function sha256Init(data: Buffer): number[] {
  const words: number[] = new Array<number>(14).fill(0);
  let head = 0;
  for (let i = 0; i < 3; i++) head = head * 256 + data[i]!;
  words.push(head >>> 0);
  let tail = 0;
  for (let i = 3; i < 7; i++) tail = tail * 256 + data[i]!;
  words.push(tail >>> 0);
  for (let index = 16; index < 30; index++) {
    let value: number = SHA256_SCHEDULE[index - 16]!;
    if (index - 2 >= 14) {
      const mixed = sigma1(words[index - 2]!);
      value = add32(
        value,
        index === 16 ? (mixed ^ SHA256_SIGMA1_ADJUSTMENT) >>> 0 : mixed
      );
    }
    if (index - 7 >= 14) value = add32(value, words[index - 7]!);
    if (index - 15 >= 14) {
      const mixed = sigma0(words[index - 15]!);
      value = add32(
        value,
        index === 29 ? (mixed ^ SHA256_SIGMA0_ADJUSTMENT) >>> 0 : mixed
      );
    }
    words.push(value);
  }
  words.push(
    add32(
      sigma1(words[28]!),
      words[23]!,
      sigma0(words[15]!),
      words[14]!,
      SHA256_ADJUSTMENT,
      // Subtraction of the untouched round constant, as modular addition.
      -SHA256_ROUND_CONSTANTS[14]!
    )
  );
  expandSha256Schedule(words, 31);
  const working = sha256Rounds(SHA256_STATE, words, 14);
  return SHA256_INITIAL.map((value, i) => add32(value, working[i]!));
}

/** Compute the SHA-256 digest for token data. */
function sha256Digest(data: Buffer): Buffer {
  if (data.length < 7) {
    throw new Error("Token salt must contain at least seven bytes");
  }
  const length = 57 + data.length;
  const rest = data.subarray(7);
  const zeroCount = positiveMod(55 - length, 64);
  const padded = Buffer.alloc(rest.length + 1 + zeroCount + 8);
  rest.copy(padded, 0);
  padded[rest.length] = 0x80;
  padded.writeBigUInt64BE(BigInt(length) * BigInt(8), padded.length - 8);
  let state = sha256Init(data.subarray(0, 7));
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words: number[] = [];
    for (let i = 0; i < 16; i++) words.push(padded.readUInt32BE(offset + i * 4));
    expandSha256Schedule(words);
    const working = sha256Rounds(state, words);
    state = state.map((value, i) => add32(value, working[i]!));
  }
  const digest = Buffer.alloc(32);
  state.forEach((word, i) => digest.writeUInt32BE(word, i * 4));
  return digest;
}

/** Compute the CS64 digest words for token data. */
function cs64Digest(data: Buffer, digest: Buffer): [number, number] {
  const keyA = (digest.readUInt32LE(0) | 1) >>> 0;
  const keyB = (digest.readUInt32LE(4) | 1) >>> 0;
  const factors = [mul32(keyA, CS64_FACTOR), mul32(keyB, CS64_FACTOR)];
  const terms = CS64_COEFFICIENTS.map(([coefficient], index) =>
    mul32(coefficient, factors[index % 2]!)
  );
  const offsets: number[] = CS64_COEFFICIENTS.map(([, offset]) => offset);
  const salted = Buffer.alloc(data.length + 1);
  data.copy(salted, 1);
  wordsLe4Even(salted).forEach((word, index) => {
    let term = mul32(word, index % 2 === 0 ? keyA : keyB);
    let offset = mul32(
      rol16(word),
      index % 2 === 0 ? 0xef0569fb : 0xc31713db
    );
    if (index === 0) {
      term = add32(term, mul32(CS64_ADJUSTMENT0, factors[0]!));
      offset = add32(offset, CS64_ADJUSTMENT1);
    }
    terms.push(term);
    offsets.push(offset);
  });
  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;
  for (let index = 0; index < terms.length; index += 2) {
    const x = terms[index]!;
    const y = terms[index + 1]!;
    let t = rol16(add32(offsets[index]!, x));
    let q = mul32(t, 0x76f50f34);
    swapAcc = add32(swapAcc, mul32(rol16(q), 0xc3efea97), q);
    t = rol16(add32(offsets[index + 1]!, y));
    q = mul32(t, 0x1881ce3c);
    swapLast = add32(mul32(rol16(q), 0x35bd1ec9), q);
    swapAcc = add32(swapAcc, swapLast);

    state = add32(mul32(state, keyA), x);
    state = mul32(rol16(state), 0xcf98b111);
    state = mul32(rol16(state), 0x87085b9f);
    state = mul32(rol16(state), 0x12ceb96d);
    state = mul32(rol16(state), 0x257e1d83);
    acc = add32(acc, state);
    t = add32(mul32(state, keyB), y);
    t = mul32(rol16(t), 0xa27416f5);
    t = mul32(rol16(t), 0xd38396ff);
    state = mul32(rol16(mul32(rol16(t), 0x7c932b89)), 0xbfa49f69);
    acc = add32(acc, state);
  }
  return [(swapLast ^ state) >>> 0, (swapAcc ^ acc) >>> 0];
}

/** Compute the token hash components: 16 hex CS64, 64 hex SHA-256. */
function tokenHash(data: Buffer): [string, string] {
  const digest = sha256Digest(data);
  const [low, high] = cs64Digest(data, digest);
  const cs64 = Buffer.alloc(8);
  cs64.writeUInt32LE(low, 0);
  cs64.writeUInt32LE(high, 4);
  return [cs64.toString("hex").toUpperCase(), digest.toString("hex").toUpperCase()];
}

/**
 * Microsoft v2 Sec-MS-GEC: `<16 hex CS64>-<64 hex SHA-256>`.
 * The time is Windows ticks rounded down to five minutes, in 100ns units,
 * prefixed to the trusted client token as ASCII.
 */
function generateSecMsGecV2(unixSeconds: number): string {
  let ticks = unixSeconds + WIN_EPOCH_SECONDS;
  ticks -= positiveMod(ticks, CLOCK_ROUND_SECONDS);
  ticks *= S_TO_100NS;
  const strToHash = `${Math.round(ticks)}${EDGE_TRUSTED_CLIENT_TOKEN}`;
  const [cs64, sha256] = tokenHash(Buffer.from(strToHash, "ascii"));
  return `${cs64}-${sha256}`;
}

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
  return generateSecMsGecV2(nowSec);
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
  const body = fishPausesToEdgeProsodyText(text);
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

export function isEdgeFormatRefusal(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /no audio|output format|unsupported format|audio format/i.test(message);
}

async function collectEdgeStream(
  opts: Parameters<typeof streamEdgeTts>[0]
): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of streamEdgeTts(opts)) {
    parts.push(Buffer.from(chunk));
  }
  if (parts.length === 0) {
    throw new Error("Edge TTS returned no audio");
  }
  return Buffer.concat(parts);
}

/**
 * One chunk with its own inactivity and total clock, retried quickly. A whole
 * section retried through {@link streamEdgeTts} repeats every chunk; here only
 * the chunk that failed is spoken again.
 */
async function synthesizeEdgeChunk(
  opts: Omit<Parameters<typeof streamEdgeTts>[0], "text">,
  text: string
): Promise<Buffer> {
  const budgetMs = opts.totalCapMs ?? edgeChunkBudgetMs(text.length);
  let lastError: unknown;
  for (let attempt = 0; attempt < EDGE_CHUNK_ATTEMPTS; attempt++) {
    if (opts.signal?.aborted) throw new Error("Edge TTS aborted");
    if (attempt > 0) {
      await new Promise((r) =>
        setTimeout(r, Math.min(2_000, EDGE_CHUNK_BACKOFF_MS * attempt))
      );
      if (opts.signal?.aborted) throw new Error("Edge TTS aborted");
    }
    const gate = edgeSocketSlot();
    await gate.acquire();
    try {
      return await collectEdgeStream({
        ...opts,
        text,
        inactivityMs: opts.inactivityMs ?? EDGE_CHUNK_INACTIVITY_MS,
        totalCapMs: budgetMs,
      });
    } catch (err) {
      lastError = err;
      if (opts.signal?.aborted) throw err;
    } finally {
      gate.release();
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Edge TTS returned no audio");
}

/**
 * Byte length of a leading ID3v2 tag, or 0. Every Edge turn starts with one,
 * so concatenating turns leaves tags (and any Xing header inside them) in the
 * middle of the file, where decoders and the frame walk do not expect them.
 */
export function edgeId3TagLength(audio: Buffer): number {
  if (audio.length < 10 || audio.toString("ascii", 0, 3) !== "ID3") return 0;
  const size =
    ((audio[6]! & 0x7f) << 21) |
    ((audio[7]! & 0x7f) << 14) |
    ((audio[8]! & 0x7f) << 7) |
    (audio[9]! & 0x7f);
  const footer = (audio[5]! & 0x10) !== 0 ? 10 : 0;
  return Math.min(audio.length, 10 + size + footer);
}

/** Synthesize pre-split chunks in parallel, keeping their spoken order. */
async function synthesizeEdgeChunks(
  chunks: string[],
  opts: Omit<Parameters<typeof streamEdgeTts>[0], "text">
): Promise<Buffer> {
  const results = new Array<Buffer | undefined>(chunks.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      const text = chunks[index];
      if (text === undefined) return;
      results[index] = await synthesizeEdgeChunk(opts, text);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(EDGE_CHUNK_CONCURRENCY, chunks.length) },
      () => worker()
    )
  );
  const ordered = results.filter((part): part is Buffer => Boolean(part));
  if (ordered.length !== chunks.length) {
    throw new Error("Edge TTS returned no audio");
  }
  // Each turn opens with its own ID3 tag (and often a Xing header frame).
  // Keep the first tag and drop the rest so the joined file has one header
  // and no metadata frame in the middle of the audio.
  const joined = ordered.map((part, i) =>
    i === 0 ? part : part.subarray(edgeId3TagLength(part))
  );
  return Buffer.concat(joined);
}

export async function synthesizeEdgeTts(opts: {
  text: string;
  voice?: string;
  speed?: number;
  language?: string;
  signal?: AbortSignal;
  openSocket?: OpenEdgeSocket;
  clockSkewSeconds?: number;
  outputFormat?: string;
  /** Test override. Production uses {@link EDGE_INACTIVITY_MS}. */
  inactivityMs?: number;
  /** Test override. Production uses {@link edgeStreamBudgetMs}. */
  totalCapMs?: number;
}): Promise<Buffer> {
  const chunks = splitEdgeText(opts.text);
  if (chunks.length > 1) {
    const { text: _text, totalCapMs: _cap, ...rest } = opts;
    void _text;
    void _cap;
    return synthesizeEdgeChunks(chunks, rest);
  }
  return collectEdgeStream(opts);
}

export async function* streamEdgeTts(opts: {
  text: string;
  voice?: string;
  speed?: number;
  language?: string;
  signal?: AbortSignal;
  openSocket?: OpenEdgeSocket;
  clockSkewSeconds?: number;
  outputFormat?: string;
  inactivityMs?: number;
  totalCapMs?: number;
}): AsyncGenerator<Uint8Array, void, unknown> {
  const preferred = opts.outputFormat || EDGE_OUTPUT_FORMAT;
  const formats =
    preferred === EDGE_OUTPUT_FORMAT_COMPAT
      ? [preferred]
      : [preferred, EDGE_OUTPUT_FORMAT_COMPAT];
  let lastError: unknown;
  for (let i = 0; i < formats.length; i++) {
    const format = formats[i]!;
    try {
      yield* streamEdgeTtsOnce({ ...opts, outputFormat: format });
      return;
    } catch (err) {
      lastError = err;
      const canRetry =
        i < formats.length - 1 && isEdgeFormatRefusal(err) && !opts.signal?.aborted;
      if (!canRetry) throw err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Edge TTS returned no audio");
}

async function* streamEdgeTtsOnce(opts: {
  text: string;
  voice?: string;
  speed?: number;
  language?: string;
  signal?: AbortSignal;
  openSocket?: OpenEdgeSocket;
  clockSkewSeconds?: number;
  outputFormat?: string;
  inactivityMs?: number;
  totalCapMs?: number;
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
  const inactivityMs = opts.inactivityMs ?? EDGE_INACTIVITY_MS;
  const totalCapMs = opts.totalCapMs ?? edgeStreamBudgetMs(text.length);
  let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  let totalTimer: ReturnType<typeof setTimeout> | null = null;
  let stalled = false;
  const clearStreamTimers = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    if (totalTimer) clearTimeout(totalTimer);
    inactivityTimer = null;
    totalTimer = null;
  };
  const stall = () => {
    if (stalled) return;
    stalled = true;
    clearStreamTimers();
    // Push before close. A sync onClose that ends the turn would otherwise
    // make a partial take look finished.
    push(new Error("Edge TTS stalled"));
    socket?.close();
  };
  const armInactivity = () => {
    if (stalled) return;
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(stall, inactivityMs);
    inactivityTimer.unref?.();
  };
  const onAbort = () => {
    clearStreamTimers();
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
        socket?.send(buildEdgeSpeechConfigMessage(opts.outputFormat || EDGE_OUTPUT_FORMAT));
        socket?.send(buildEdgeSsmlMessage(ssml, requestId));
      },
      onMessage: (data) => {
        armInactivity();
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
      socket.send(buildEdgeSpeechConfigMessage(opts.outputFormat || EDGE_OUTPUT_FORMAT));
      socket.send(buildEdgeSsmlMessage(ssml, requestId));
    }

    totalTimer = setTimeout(stall, totalCapMs);
    totalTimer.unref?.();
    armInactivity();

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
    clearStreamTimers();
    opts.signal?.removeEventListener("abort", onAbort);
    socket?.close();
  }
}
