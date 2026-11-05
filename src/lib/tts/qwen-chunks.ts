/**
 * Sentence-aware chunking for Qwen TTS Flash.
 *
 * Each call carries about 10–15 s of audio (Qwen reads ~18 characters a
 * second). Chunks never cross a paragraph; a sentence that is too long on its
 * own is cut at a clause mark, then at a space.
 */

import { isAbbreviationBoundary } from "@/lib/tts/speakable-text";

export const QWEN_CHUNK_TARGET_CHARS = 220;
export const QWEN_CHUNK_MAX_CHARS = 320;
/** A paragraph shorter than this rides along with the next one. */
export const QWEN_CHUNK_MIN_PARAGRAPH_CHARS = 40;

/** What precedes a chunk; the joiner turns it into a pause length. */
export type QwenBoundary = "start" | "paragraph" | "sentence" | "clause";

export type QwenChunk = {
  index: number;
  text: string;
  boundary: QwenBoundary;
};

export type QwenChunkOptions = {
  targetChars?: number;
  maxChars?: number;
};

const SENTENCE_END = /[.!?…]+["'”’)\]]*\s+/g;
const CLAUSE_END = /[;:—–,]["'”’)\]]*\s*/g;

export function splitSentences(paragraph: string): string[] {
  const text = paragraph.replace(/\s+/g, " ").trim();
  if (!text) return [];
  const out: string[] = [];
  let start = 0;
  SENTENCE_END.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SENTENCE_END.exec(text))) {
    const end = m.index + m[0].length;
    const chunk = text.slice(start, end).trim();
    const next = text.slice(end);
    if (!chunk || isAbbreviationBoundary(chunk, next)) continue;
    out.push(chunk);
    start = end;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

/** Cut one over-long sentence near `target`, never past `max`. */
export function splitLongSentence(
  sentence: string,
  target: number,
  max: number
): string[] {
  const pieces: string[] = [];
  let rest = sentence.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = -1;
    let best = Infinity;
    CLAUSE_END.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CLAUSE_END.exec(window))) {
      const end = m.index + m[0].length;
      if (end < target * 0.4 || end >= window.length) continue;
      const d = Math.abs(end - target);
      if (d < best) {
        best = d;
        cut = end;
      }
    }
    if (cut <= 0) {
      const space = window.lastIndexOf(" ", target);
      const fallback = space > target * 0.4 ? space : window.lastIndexOf(" ");
      cut = fallback > 0 ? fallback + 1 : max;
    }
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces.filter(Boolean);
}

function paragraphsOf(text: string): string[] {
  const raw = text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const merged: string[] = [];
  let carry = "";
  for (const p of raw) {
    const joined = carry ? `${carry} ${p}` : p;
    if (joined.length < QWEN_CHUNK_MIN_PARAGRAPH_CHARS) {
      carry = /[.!?…:;]["'”’)\]]*$/.test(joined) ? joined : `${joined}.`;
      continue;
    }
    merged.push(joined);
    carry = "";
  }
  if (carry) merged.push(carry);
  return merged;
}

export function chunkQwenText(
  text: string,
  opts: QwenChunkOptions = {}
): QwenChunk[] {
  const target = Math.max(60, opts.targetChars ?? QWEN_CHUNK_TARGET_CHARS);
  const max = Math.max(target, opts.maxChars ?? QWEN_CHUNK_MAX_CHARS);
  const chunks: QwenChunk[] = [];
  const push = (t: string, boundary: QwenBoundary) =>
    chunks.push({
      index: chunks.length,
      text: t,
      boundary: chunks.length === 0 ? "start" : boundary,
    });

  for (const paragraph of paragraphsOf(text)) {
    let open = "";
    let openBoundary: QwenBoundary = "paragraph";
    for (const sentence of splitSentences(paragraph)) {
      const parts =
        sentence.length > max ? splitLongSentence(sentence, target, max) : [sentence];
      parts.forEach((part, i) => {
        const boundary: QwenBoundary = i > 0 ? "clause" : "sentence";
        if (!open) {
          open = part;
          return;
        }
        const fits = open.length + 1 + part.length <= target;
        if (fits && boundary === "sentence") {
          open = `${open} ${part}`;
          return;
        }
        push(open, openBoundary);
        open = part;
        openBoundary = boundary;
      });
    }
    if (open) push(open, openBoundary);
  }
  return chunks;
}
