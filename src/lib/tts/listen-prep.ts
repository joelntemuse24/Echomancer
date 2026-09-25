/**
 * Whole-book listen cleanup before a take-home script is frozen.
 *
 * The book is split into chunks of about 8k tokens and cleaned in parallel.
 * The model returns ids only: lines to drop, and lines that are headings.
 * Kept text is the original bytes with those lines removed. A timeout or a
 * bad reply tries the fallback model, then keeps the pre-pass text. Protected
 * reading lines are restored. Index, contents, notes, and bibliography lines
 * stay droppable.
 */

import { getOpenRouterApiKey } from "@/lib/tts/providers/openrouter";
import { isChapterHeading } from "@/lib/tts/speakable-text";

export const DEFAULT_LISTEN_PREP_MODEL = "google/gemini-3.8-flash";
export const DEFAULT_LISTEN_PREP_FALLBACK_MODEL = "deepseek/deepseek-v4.1-flash";
/** About 4 characters per token. Target ~8k tokens, hard cap ~10k. */
export const LISTEN_PREP_CHARS_PER_TOKEN = 4;
export const LISTEN_PREP_TARGET_TOKENS = 8_000;
export const LISTEN_PREP_MAX_TOKENS = 10_000;
export const LISTEN_PREP_TARGET_CHARS =
  LISTEN_PREP_TARGET_TOKENS * LISTEN_PREP_CHARS_PER_TOKEN;
export const LISTEN_PREP_MAX_CHARS =
  LISTEN_PREP_MAX_TOKENS * LISTEN_PREP_CHARS_PER_TOKEN;
export const DEFAULT_LISTEN_PREP_CONCURRENCY = 8;
export const DEFAULT_LISTEN_PREP_GLOBAL_CONCURRENCY = 20;
export const DEFAULT_LISTEN_PREP_CHUNK_TIMEOUT_MS = 20_000;
export const DEFAULT_LISTEN_PREP_RETRY_MS = 2_500;
export const LISTEN_PREP_OUTPUT_TOKENS = 4_000;
/** A prose-only drop larger than this is refused. Clutter drops are not shed to fit it. */
export const LISTEN_PREP_MAX_DROP_SHARE = 0.4;
/** Failed chunks are retried this many times, then the book proceeds with the best text. */
export const LISTEN_PREP_MAX_ATTEMPTS = 3;
/** How long freeze waits for another process's pass before cleaning itself. */
export const DEFAULT_LISTEN_PREP_PASS_WAIT_MS = 45_000;

const CLUTTER_LINE =
  /copyright|all rights reserved|\bisbn\b|cataloging|table of contents|^contents$|permission|published by|\bindex\b|footnote|gutenberg|^\d{1,4}$/i;

const OPENROUTER_CHAT_URL =
  (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(
    /\/+$/,
    ""
  ) + "/chat/completions";

const PRIMARY_PROVIDER = {
  require_parameters: true,
  allow_fallbacks: true,
  order: ["google-ai-studio", "google-vertex"],
} as const;

const FALLBACK_PROVIDER = {
  require_parameters: true,
  order: ["together", "deepinfra"],
} as const;

export type ListenPrepFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export type ListenOps = {
  drop: number[];
  headings: number[];
  note?: ListenNote | null;
};

export type ListenNote = {
  kind: "article" | "biography" | "history" | "nonfiction" | "novel" | null;
  novelKind: string | null;
  tone: string;
  pov: string;
  dialogue: "low" | "medium" | "high" | null;
};

export type ListenPrepResult = {
  text: string;
  droppedLines: number;
  failOpenChunks: number;
  /** Chunks whose drops were refused or cut back by the guard. */
  rejectedChunks: number;
  chunkCount: number;
  wallMs: number;
  p50Ms: number;
  maxMs: number;
  model: string;
  fallbackChunks: number;
  notes: ListenNote[];
  /** First dropped line, trimmed, for the job log. */
  sample: string;
  /** Per chunk, in order. `ok` is a primary-model success, not a fallback or fail-open. */
  chunks: ListenChunkRecord[];
};

export type ListenChunkRecord = {
  ok: boolean;
  text: string;
  note: ListenNote | null;
};

type LineSpan = {
  /** 1-based id inside its chunk. */
  id: number;
  text: string;
  start: number;
  end: number;
};

export function listenPrepModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.LISTEN_PREP_MODEL?.trim() || DEFAULT_LISTEN_PREP_MODEL;
}

export function listenPrepFallbackModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.LISTEN_PREP_FALLBACK_MODEL?.trim() || DEFAULT_LISTEN_PREP_FALLBACK_MODEL;
}

export function listenPrepGlobalConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.LISTEN_PREP_GLOBAL_CONCURRENCY);
  if (Number.isFinite(n) && n >= 1 && n <= 64) return Math.floor(n);
  return DEFAULT_LISTEN_PREP_GLOBAL_CONCURRENCY;
}

export function listenPrepRetryMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.LISTEN_PREP_RETRY_MS);
  if (Number.isFinite(n) && n >= 0 && n <= 10_000) return Math.floor(n);
  return DEFAULT_LISTEN_PREP_RETRY_MS;
}

export function listenPrepConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.LISTEN_PREP_CONCURRENCY);
  if (Number.isFinite(n) && n >= 1 && n <= 32) return Math.floor(n);
  return DEFAULT_LISTEN_PREP_CONCURRENCY;
}

export function listenPrepChunkTimeoutMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const n = Number(env.LISTEN_PREP_CHUNK_TIMEOUT_MS);
  if (Number.isFinite(n) && n >= 1_000 && n <= 120_000) return Math.floor(n);
  return DEFAULT_LISTEN_PREP_CHUNK_TIMEOUT_MS;
}

export function listenPrepPassWaitMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const n = Number(env.LISTEN_PREP_PASS_WAIT_MS);
  if (Number.isFinite(n) && n >= 0 && n <= 120_000) return Math.floor(n);
  return DEFAULT_LISTEN_PREP_PASS_WAIT_MS;
}

/** Bake-off prompt, plus a per-chunk note for the narrator suggestion. */
export function listenPrepSystemPrompt(): string {
  return `${BAKEOFF_SYSTEM_PROMPT}
Also include "note" for this chunk only: {"kind":"article"|"biography"|"history"|"nonfiction"|"novel"|null,"novelKind":string|null,"tone":string,"pov":string,"dialogue":"low"|"medium"|"high"|null}.`;
}

const BAKEOFF_SYSTEM_PROMPT = `You clean up the text of a book before it is read aloud as an audiobook.
You receive one chunk of the book. Each unit (a paragraph or line) starts with its ID in square brackets, like [12].
You never rewrite, merge or split text. You only decide which unit IDs to DROP and which are HEADINGS.

DROP a unit only when the whole unit is non-reading clutter:
- page numbers, alone or combined with a running header or footer
- running headers/footers: the book title, author, or chapter title repeated at page tops or bottoms, often appearing between the two halves of a sentence that continues across a page break
- copyright notices, ISBN, Library of Congress / cataloging-in-publication data, printer's key lines (e.g. "10 9 8 7 6 5 4 3 2 1"), "Printed in ...", publisher imprint and address, credits, permissions, series pages, editorial boards
- table of contents and list of illustrations entries (including their "Contents" title), and index entries (including the "Index" title and letter dividers)
- scan and digitization artifacts: library stamps, barcodes, call numbers, "digitized by" notices, OCR garbage with no readable words, debris from music notation or images
- e-book boilerplate such as Project Gutenberg headers, metadata and license sections
- publisher advertisements, "Also by" lists, review blurbs
- endnotes and footnote text (e.g. "12. Smith, History, 45." or "* Translated in ...")

NEVER DROP:
- any text of the book itself, however short: a one-line paragraph, a single word or number spoken in dialogue, a fragment that continues a sentence from the previous page, or prose full of OCR errors
- dedications, epigraphs and their attributions, poems and verse, song lyrics, letters (including their date lines, addresses and sign-offs), numbered paragraphs and list items that belong to the text
- prefaces, forewords, introductions, translator's notes, acknowledgements, prologues and epilogues
- chapter, part and section titles (list those as headings instead)
If a unit mixes clutter with real text (for example a running header glued onto the start of a sentence), KEEP it.
When unsure, KEEP. Silently deleting real words from the audiobook is far worse than leaving some clutter in.

HEADINGS: IDs of units that are titles of chapters, parts, sections, letters or numbered poems in the reading text, including bare numbers or words used as chapter titles ("II", "Seven", "Chapter 3"). Never list running headers, table-of-contents lines or index letters as headings.

Reply with JSON only, no prose and no markdown:
{"drop": [...], "headings": [...], "note": {"kind": null, "novelKind": null, "tone": "", "pov": "", "dialogue": null}}
Each list element is a string: a single ID like "7" or an inclusive range like "40-97". Use ranges for runs of consecutive IDs. Use empty lists when nothing applies.`;

/** Line spans over the original string. `end` includes that line's newline. */
export function lineSpans(text: string): LineSpan[] {
  const spans: LineSpan[] = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === "\n") {
      if (i === text.length && start === text.length && spans.length > 0) break;
      const end = i === text.length ? text.length : i + 1;
      const raw = text.slice(start, i);
      spans.push({
        id: spans.length + 1,
        text: raw.endsWith("\r") ? raw.slice(0, -1) : raw,
        start,
        end,
      });
      start = end;
    }
  }
  return spans;
}

export function splitListenChunks(
  text: string,
  targetChars = LISTEN_PREP_TARGET_CHARS,
  maxChars = LISTEN_PREP_MAX_CHARS
): string[] {
  if (!text) return [];
  const lines = lineSpans(text);
  const chunks: string[] = [];
  let chunkStart = 0;
  let chunkLen = 0;
  const flush = (end: number) => {
    if (end > chunkStart) chunks.push(text.slice(chunkStart, end));
  };
  for (const line of lines) {
    const len = line.end - line.start;
    if (chunkLen > 0 && chunkLen + len > targetChars && chunkLen >= targetChars * 0.6) {
      flush(line.start);
      chunkStart = line.start;
      chunkLen = 0;
    }
    if (len > maxChars && chunkLen === 0) {
      flush(line.end);
      chunkStart = line.end;
      chunkLen = 0;
      continue;
    }
    chunkLen += len;
    if (chunkLen >= maxChars) {
      flush(line.end);
      chunkStart = line.end;
      chunkLen = 0;
    }
  }
  flush(text.length);
  return chunks;
}

export function numberedChunk(chunk: string): string {
  return lineSpans(chunk)
    .map((line) => `[${line.id}] ${line.text}`)
    .join("\n");
}

function unwrapJson(raw: string): unknown {
  let t = raw.trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) t = fenced[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

function messageContent(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") {
    return "";
  }
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  return typeof message?.content === "string" ? message.content : "";
}

export function coerceListenOps(value: unknown, lineCount: number): ListenOps | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { drop?: unknown; headings?: unknown; note?: unknown };
  const ids = (raw: unknown): number[] => {
    if (!Array.isArray(raw)) return [];
    const out: number[] = [];
    for (const item of raw) addListenId(out, item, lineCount);
    return out;
  };
  if (!Array.isArray(row.drop) && !Array.isArray(row.headings)) return null;
  return { drop: ids(row.drop), headings: ids(row.headings), note: coerceListenNote(row.note) };
}

function addListenId(out: number[], item: unknown, lineCount: number): void {
  const push = (n: number) => {
    if (!Number.isInteger(n) || n < 1 || n > lineCount || out.includes(n)) return;
    out.push(n);
  };
  const expand = (start: number, end: number) => {
    if (start > end) [start, end] = [end, start];
    if (end - start > 2_000) return;
    for (let n = start; n <= end; n++) push(n);
  };
  if (typeof item === "number" && !Number.isNaN(item)) {
    push(Math.trunc(item));
    return;
  }
  if (Array.isArray(item) && item.length === 2) {
    expand(Math.trunc(Number(item[0])), Math.trunc(Number(item[1])));
    return;
  }
  if (typeof item !== "string") return;
  const text = item.trim();
  const range = text.match(/^\[?(\d+)\]?\s*(?:-|–|to|\.\.)\s*\[?(\d+)\]?$/);
  if (range) {
    expand(Number(range[1]), Number(range[2]));
    return;
  }
  const single = text.match(/^\[?(\d+)\]?$/);
  if (single) push(Number(single[1]));
}

const CLUTTER_KW =
  /copyright|©|\bisbn\b|all rights reserved|library of congress|cataloging|printed in|gutenberg|licen[cs]e|trademark|permission|www\.|https?:\/\/|\bpp?\.\s*\d|\bibid\b|\bop\. cit/i;
const BARE_NUM = /^[^\w“”"‘’']{0,2}(\d{1,3})[^\w“”"‘’']{0,2}$/;
/** Running headers repeat at page boundaries across many pages. */
const RUNNING_HEADER_MIN_PAGES = 5;

/** Bake-off prose veto: long, mostly lowercase, and not a clutter or index line. */
export function isProseLikeLine(line: string): boolean {
  const words = line.match(/[A-Za-z']+/g) || [];
  if (line.length < 150 || words.length < 20) return false;
  const lower = words.filter((word) => word[0] && word[0] === word[0].toLowerCase()).length / words.length;
  if ((line.match(/\b\d+\b/g) || []).length >= 4 || /\bSee also\b|\bSee \w/.test(line)) return false;
  return lower > 0.55 && !CLUTTER_KW.test(line) && !/^\s*[\d.•*]+[A-Z]?[\d.]*\s/.test(line);
}

export function withoutProseDrops(chunk: string, ops: ListenOps): ListenOps {
  const prose = new Set(
    lineSpans(chunk).filter((line) => isProseLikeLine(line.text)).map((line) => line.id)
  );
  return { ...ops, drop: ops.drop.filter((id) => !prose.has(id)) };
}

const GUTENBERG_START = /\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG/i;
const GUTENBERG_END = /\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG/i;

/**
 * Ids the pre-pass may remove on its own: sequential page numbers and
 * Gutenberg boilerplate. Headers and contents are not removed here.
 */
export function prepassDropIds(lines: Array<{ id: number; text: string }>): number[] {
  const drop = new Set<number>();
  const numbers = lines.flatMap((line) => {
    const match = BARE_NUM.exec(line.text.trim());
    return match ? [{ id: line.id, value: Number(match[1]) }] : [];
  });
  numbers.forEach((page, index) => {
    const neighbors = numbers.slice(Math.max(0, index - 2), index).concat(numbers.slice(index + 1, index + 3));
    const sequential = neighbors.some((other) => {
      const gap = Math.abs(page.value - other.value);
      const distance = Math.abs(page.id - other.id);
      const forward = (other.value - page.value) * (other.id - page.id) > 0;
      return gap > 0 && gap <= 3 && distance <= 40 && forward;
    });
    if (sequential) drop.add(page.id);
  });
  const start = lines.find((line) => GUTENBERG_START.test(line.text));
  const end = lines.find((line) => GUTENBERG_END.test(line.text));
  if (start) for (let id = 1; id <= start.id; id++) drop.add(id);
  if (end) for (let id = end.id; id <= lines.length; id++) drop.add(id);
  for (const id of headerDropIds(lines, RUNNING_HEADER_MIN_PAGES, 60)) drop.add(id);
  return [...drop];
}

export function bookTitleLine(text: string): { id: number; text: string } | null {
  const line = lineSpans(text).find((row) => row.text.trim());
  if (!line) return null;
  return { id: line.id, text: line.text.trim() };
}

const CONTENTS_LABEL = /^(?:table of )?contents(?:\s+(?:[ivxlcdm]+|\d{1,4}))?$/i;
const ROMAN_PAGE =
  /^(?:(?=[ivxlcdm]+$)m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3}))$/i;

function nextFilled(
  lines: Array<{ id: number; text: string }>,
  index: number
): { id: number; text: string } | null {
  for (let i = index + 1; i < lines.length; i++) {
    if (lines[i]?.text.trim()) return lines[i]!;
  }
  return null;
}

function isOrdinarySentence(line: string): boolean {
  const t = line.trim();
  const words = t.match(/[A-Za-z']+/g) || [];
  if (words.length < 6 || !/[.!?]["”’]?$/.test(t)) return false;
  const lower = words.filter((word) => word[0] === word[0]!.toLowerCase()).length;
  return lower / words.length > 0.5;
}

function isSpeakerLabel(text: string): boolean {
  const t = text.trim();
  if (/:$/.test(t)) return true;
  if (/[a-z]/.test(t) || /\s/.test(t)) return false;
  return /^[A-Z][A-Z'’.-]{1,}$/.test(t);
}

function followedBySpeech(
  lines: Array<{ id: number; text: string }>,
  index: number,
  text: string
): boolean {
  if (!isSpeakerLabel(text)) return false;
  const next = nextFilled(lines, index);
  if (!next) return false;
  const speech = next.text.trim();
  if (!speech || BARE_NUM.test(speech)) return false;
  if (/^[“"‘']/.test(speech)) return true;
  if (/:$/.test(text.trim())) return /[A-Za-z]/.test(speech);
  return speech.length <= 160 && /[A-Za-z]/.test(speech);
}

function prevFilledText(
  lines: Array<{ id: number; text: string }>,
  index: number
): string {
  for (let i = index - 1; i >= 0; i--) {
    const text = lines[i]?.text.trim() ?? "";
    if (text) return text;
  }
  return "";
}

function atPageTop(lines: Array<{ id: number; text: string }>, index: number): boolean {
  return BARE_NUM.test(prevFilledText(lines, index));
}

function blankIsolated(lines: Array<{ id: number; text: string }>, index: number): boolean {
  const prev = index > 0 ? lines[index - 1]?.text ?? "" : "";
  const next = index + 1 < lines.length ? lines[index + 1]?.text ?? "" : "";
  const prevBlank = index === 0 || !prev.trim();
  const nextBlank = index === lines.length - 1 || !next.trim();
  return prevBlank && nextBlank;
}

function headerPunctuation(text: string): boolean {
  return /[.!?,"“”‘’;:]/.test(text) || /[.!?,"“”‘’;:]$/.test(text);
}

/**
 * A running header sits at the top of a page or on its own between blank
 * lines. Quoted lines, sentence punctuation, and speaker labels are reading.
 */
function isHeaderCandidate(
  lines: Array<{ id: number; text: string }>,
  index: number,
  text: string
): boolean {
  const key = text.trim();
  if (!key || key.length > 80) return false;
  if (/[“"‘']/.test(key) || headerPunctuation(key)) return false;
  if (followedBySpeech(lines, index, key)) return false;
  if (!atPageTop(lines, index) && !blankIsolated(lines, index)) return false;
  return atPageTop(lines, index) || blankIsolated(lines, index);
}

function headerCounts(lines: Array<{ id: number; text: string }>): Map<string, number> {
  const counts = new Map<string, number>();
  lines.forEach((line, index) => {
    const key = line.text.trim();
    if (!isHeaderCandidate(lines, index, key)) return;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return counts;
}

/** Texts that repeat at page boundaries often enough to be running headers. */
export function runningHeaderTexts(
  lines: Array<{ id: number; text: string }>,
  minPages = RUNNING_HEADER_MIN_PAGES
): Set<string> {
  const out = new Set<string>();
  for (const [key, count] of headerCounts(lines)) {
    if (count >= minPages) out.add(key);
  }
  return out;
}

function firstTextId(lines: Array<{ id: number; text: string }>): number | null {
  return lines.find((line) => line.text.trim())?.id ?? null;
}

/** Ids a header rule may remove. The book's first line is never one of them. */
function headerDropIds(
  lines: Array<{ id: number; text: string }>,
  minPages: number,
  maxChars: number
): number[] {
  const counts = headerCounts(lines);
  const first = firstTextId(lines);
  const ids: number[] = [];
  lines.forEach((line, index) => {
    const key = line.text.trim();
    if (line.id === first || key.length > maxChars) return;
    if ((counts.get(key) || 0) < minPages) return;
    if (!isHeaderCandidate(lines, index, key)) return;
    ids.push(line.id);
  });
  return ids;
}

function isRomanPageToken(token: string): boolean {
  return ROMAN_PAGE.test(token.trim());
}

function sentenceEnding(line: string): boolean {
  return /[.!?]["”’]?$/.test(line.trim());
}

function mostlyLowercase(line: string): boolean {
  const words = line.match(/[A-Za-z']+/g) || [];
  if (words.length < 3) return false;
  const lower = words.filter((word) => word[0] === word[0]!.toLowerCase()).length;
  return lower / words.length > 0.5;
}

/** A short contents row: no sentence ending and no opening quote. */
function isContentsRow(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 80 || /^[“"‘']/.test(t) || sentenceEnding(t)) return false;
  if (isOrdinarySentence(t) || mostlyLowercase(t)) return false;
  if (!/[A-Z]/.test(t) && !/\d/.test(t)) return false;
  return true;
}

function isBareMatterLabel(text: string): boolean {
  return /^(?:chapter|part|section)\s+(?:\d+|[ivxlcdm]+)$/i.test(text.trim());
}

function entryTitle(line: string): string {
  return line
    .trim()
    .replace(/^(?:\d+[.)]?|[ivxlcdm]+[.)]?)\s+/i, "")
    .replace(/\s+\d{1,4}$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function repeatsSeenTitle(line: string, seen: string[]): boolean {
  const title = entryTitle(line);
  if (!title || title.length < 4) return false;
  return seen.some((prev) => prev === title || prev.startsWith(`${title} `) || prev.endsWith(` ${title}`));
}

/**
 * After a Contents label, every short non-sentence until prose, speech,
 * or a repeated entry title. This set does not drop anything by itself.
 */
export function contentsEntryIds(lines: Array<{ id: number; text: string }>): Set<number> {
  const ids = new Set<number>();
  const seen: string[] = [];
  let inContents = false;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.text.trim();
    if (!text) continue;
    if (CONTENTS_LABEL.test(text)) {
      inContents = true;
      ids.add(lines[i]!.id);
      continue;
    }
    if (!inContents) continue;
    if (
      /^[“"‘']/.test(text) ||
      followedBySpeech(lines, i, text) ||
      sentenceEnding(text) ||
      isOrdinarySentence(text) ||
      mostlyLowercase(text) ||
      repeatsSeenTitle(text, seen)
    ) {
      inContents = false;
      continue;
    }
    if (!isContentsRow(text) && !BARE_NUM.test(text) && !isRomanPageToken(text)) {
      inContents = false;
      continue;
    }
    if (isBareMatterLabel(text)) {
      const next = nextFilled(lines, i);
      const nextText = next?.text.trim() ?? "";
      const nextIndex = next ? lines.findIndex((line) => line.id === next.id) : -1;
      const continues =
        nextIndex >= 0 &&
        isContentsRow(nextText) &&
        !followedBySpeech(lines, nextIndex, nextText);
      if (!continues) {
        inContents = false;
        continue;
      }
    }
    ids.add(lines[i]!.id);
    const title = entryTitle(text);
    if (title) seen.push(title);
  }
  return ids;
}

function isUnlabeledContentsLine(line: string): boolean {
  const t = line.trim();
  if (!isContentsRow(t) && !BARE_NUM.test(t) && !isRomanPageToken(t)) return false;
  const parts = t.split(/\s+/);
  const tail = parts[parts.length - 1] ?? "";
  const page = /^\d{1,4}$/.test(tail) || isRomanPageToken(tail);
  if (/^\d+[.)]?\s+\S/.test(t)) return true;
  if (page && parts.length >= 3) return true;
  if (BARE_NUM.test(t) || isRomanPageToken(t) || /^\d+\.$/.test(t)) return true;
  return false;
}

/** A run of three or more contents-shaped lines with no Contents label. */
function unlabeledContentsIds(lines: Array<{ id: number; text: string }>): Set<number> {
  const ids = new Set<number>();
  let run: number[] = [];
  const flush = () => {
    if (run.length >= 3) for (const id of run) ids.add(id);
    run = [];
  };
  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;
    if (isUnlabeledContentsLine(text)) run.push(line.id);
    else flush();
  }
  flush();
  return ids;
}

/**
 * Lines a model drop may remove even though they look like short reading.
 * The book's first line is never included. This set does not drop anything by itself.
 */
export function permittedModelDropIds(
  lines: Array<{ id: number; text: string }>,
  headerTexts?: Set<string>,
  opts?: { strict?: boolean }
): Set<number> {
  if (opts?.strict) return new Set();
  const ids = new Set<number>([...contentsEntryIds(lines), ...unlabeledContentsIds(lines)]);
  const texts = headerTexts ?? runningHeaderTexts(lines, 2);
  const first = firstTextId(lines);
  lines.forEach((line, index) => {
    const key = line.text.trim();
    if (!key || line.id === first || !texts.has(key)) return;
    if (!isHeaderCandidate(lines, index, key)) return;
    ids.add(line.id);
  });
  return ids;
}

/** Drop ids the model or the page-number pre-pass asked for. Permitted lines are not restored. */
export function guardDropIds(
  chunk: string,
  dropIds: number[],
  headings: number[] = [],
  permit: Iterable<number> = []
): number[] {
  const headingSet = new Set(headings);
  const permitSet = new Set(permit);
  const lines = new Map(lineSpans(chunk).map((line) => [line.id, line.text]));
  return dropIds.filter((id) => {
    if (permitSet.has(id)) return true;
    if (headingSet.has(id)) return false;
    const text = lines.get(id);
    if (text == null) return false;
    return !isProtectedReadingLine(text);
  });
}

/**
 * An index, contents, or notes chunk: most lines cite a page. A copyright
 * page is the same kind of chunk. Header and contents guesses do not qualify.
 */
export function isIndexLikeChunk(chunk: string): boolean {
  const lines = lineSpans(chunk).filter((line) => line.text.trim());
  if (lines.length < 4) return false;
  const structural = lines.filter(
    (line) => hasPageNumberRef(line.text) || isClutterLine(line.text) || isReferenceLine(line.text)
  ).length;
  return structural / lines.length >= 0.6;
}

/** First line used for title-once. A chapter heading is not a book title. */
export function listenBookTitle(text: string): string | null {
  const title = bookTitleLine(text)?.text ?? "";
  if (!title || isChapterHeading(title)) return null;
  return title;
}

export function deterministicPrepass(text: string): string {
  const lines = lineSpans(text);
  const raw = prepassDropIds(lines);
  const drop = guardDropIds(text, raw, [], raw);
  if (drop.length === 0) return text;
  const next = applyListenOps(text, { drop, headings: [] });
  return next.trim() ? next : text;
}

const NOTE_KINDS = ["article", "biography", "history", "nonfiction", "novel"] as const;

export function coerceListenNote(value: unknown): ListenNote | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const kind = NOTE_KINDS.includes(row.kind as (typeof NOTE_KINDS)[number])
    ? (row.kind as ListenNote["kind"])
    : null;
  const dialogue =
    row.dialogue === "low" || row.dialogue === "medium" || row.dialogue === "high"
      ? row.dialogue
      : null;
  const text = (raw: unknown, max: number) =>
    typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, max) : "";
  const novelKind = text(row.novelKind, 40);
  const tone = text(row.tone, 40);
  const pov = text(row.pov, 40);
  if (!kind && !dialogue && !novelKind && !tone && !pov) return null;
  return { kind, novelKind: novelKind || null, tone, pov, dialogue };
}

/** A printed label (page number, copyright, ISBN), not a line of reading. */
export function isClutterLine(line: string): boolean {
  const t = line.trim();
  return t.length > 0 && CLUTTER_LINE.test(t);
}

/** Reading, including short dialogue, verse, and stage lines. */
export function isSentenceLikeLine(line: string): boolean {
  const t = line.trim();
  if (!t || isClutterLine(t)) return false;
  return /[A-Za-z]/.test(t);
}

const TRAILING_PAGE_CITE =
  /((?:,\s*\d{1,4}(?:\s*[-–—]\s*\d{1,4})?)+)\s*\.?\s*$/;

function trailingNumbersAreYears(cite: string): boolean {
  const nums = [...cite.matchAll(/\d{1,4}/g)].map((match) => match[0]);
  return nums.length > 0 && nums.every((n) => n.length === 4 && /^(?:1[5-9]|20)/.test(n));
}

/** A printed page citation: comma pages, ranges, leaders, or pp. A bare year is not one. */
export function hasPageNumberRef(line: string): boolean {
  const t = line.trim();
  if (!t || isProseLikeLine(t) || isOrdinarySentence(t) || t.length > 200) return false;
  if (t.length <= 160 && /\b(?:pp?|pages?)\.?\s*\d{1,4}\b/i.test(t)) return true;
  const cite = t.match(TRAILING_PAGE_CITE);
  if (cite?.[1] && !trailingNumbersAreYears(cite[1])) return true;
  if (/(\.{3,}|…{2,}|·{3,}|_{3,})\s*\d{1,4}\s*$/.test(t)) return true;
  if (t.length <= 80 && /\d{1,4}\s*[-–—]\s*\d{1,4}\s*$/.test(t) && !/\band\b/i.test(t)) {
    return true;
  }
  return false;
}

function isChicagoBibliography(line: string): boolean {
  const t = line.trim();
  if (t.length < 20 || t.length > 240 || isProseLikeLine(t)) return false;
  if (/[“"‘']/.test(t)) return false;
  if (/\b(?:was|were|said|walked|kept|looked)\b/i.test(t)) return false;
  return /\b[\p{L}][\p{L}.'’ -]{0,40}:\s+[\p{L}0-9][\p{L}0-9&.'’ -]{0,60},\s+(?:1[5-9]\d{2}|20\d{2})\b/u.test(
    t
  );
}

/**
 * Index, contents, notes, and bibliography lines. These are droppable even
 * when they contain letters. A real sentence is not one of these.
 * A cross-reference is "see" at the start or after a comma. A trailing
 * number is not enough unless it is a page citation.
 */
export function isReferenceLine(line: string): boolean {
  const t = line.trim();
  if (!t || isProseLikeLine(t) || isOrdinarySentence(t)) return false;
  if (/\bsee also\b/i.test(t) || /^(?:see)\b/i.test(t)) return true;
  if (/,\s*see\s+[A-Z]/i.test(t) && t.length <= 80) return true;
  if (/\.{3,}|…{2,}|·{3,}|_{3,}/.test(t)) return true;
  if (/^\d{1,3}\.\s+Ibid\b/i.test(t) || (/\bIbid\b/i.test(t) && t.length <= 80)) return true;
  if (
    /^\d{1,3}\.\s+\S/.test(t) &&
    t.length <= 240 &&
    /\([^)]*:\s*[^)]+,\s*(?:1[5-9]\d{2}|20\d{2})\)/.test(t)
  ) {
    return true;
  }
  if (isChicagoBibliography(t)) return true;
  if (hasPageNumberRef(t) && t.length <= 160 && !/[.?!]["”’]\s*$/.test(t)) return true;
  return false;
}

/** The first line of a book when it is a short title, not a page number or a contents entry. */
export function isBookTitleLine(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 80 || isClutterLine(t) || isProseLikeLine(t)) return false;
  if (/\d|\bsee also\b|\.{3,}|…{2,}/i.test(t)) return false;
  const words = t.match(/[A-Za-z][A-Za-z']*/g) || [];
  return words.length >= 1 && words.length <= 12;
}

/** Lines the guard must keep: long prose, or any reading line that is not a reference entry. */
export function isProtectedReadingLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (isProseLikeLine(t) || isOrdinarySentence(t)) return true;
  return isSentenceLikeLine(t) && !isReferenceLine(t);
}

/**
 * Contiguous labels before the first line of reading, and after the last.
 * The body is everything between those two lines.
 */
export function matterLineIds(lines: Array<{ id: number; text: string }>): {
  leading: Set<number>;
  trailing: Set<number>;
  bodySentence: number[];
} {
  const sentence = lines.filter((line) => isSentenceLikeLine(line.text));
  if (sentence.length === 0) {
    return {
      leading: new Set(lines.map((line) => line.id)),
      trailing: new Set(),
      bodySentence: [],
    };
  }
  const first = sentence[0]!.id;
  const last = sentence[sentence.length - 1]!.id;
  const leading = new Set<number>();
  const trailing = new Set<number>();
  const bodySentence: number[] = [];
  for (const line of lines) {
    if (line.id < first) leading.add(line.id);
    else if (line.id > last) trailing.add(line.id);
    else if (isSentenceLikeLine(line.text)) bodySentence.push(line.id);
  }
  return { leading, trailing, bodySentence };
}

export function dropShare(chunk: string, drop: number[]): number {
  const lines = lineSpans(chunk);
  if (chunk.length === 0 || drop.length === 0) return 0;
  const ids = new Set(drop);
  let dropped = 0;
  for (const line of lines) {
    if (ids.has(line.id)) dropped += line.end - line.start;
  }
  return dropped / chunk.length;
}

/**
 * Remove dropped lines. Every kept slice is copied from the original chunk.
 * Headings stay in place; they do not change bytes.
 */
export function applyListenOps(chunk: string, ops: ListenOps): string {
  if (ops.drop.length === 0) return chunk;
  const lines = lineSpans(chunk);
  const drop = new Set(ops.drop);
  let out = "";
  let cursor = 0;
  let droppedPage = false;
  for (const line of lines) {
    if (!drop.has(line.id)) {
      if (
        droppedPage &&
        line.text.trim() &&
        isChapterHeading(line.text) &&
        !`${out}${chunk.slice(cursor, line.start)}`.endsWith("\n\n")
      ) {
        const base = `${out}${chunk.slice(cursor, line.start)}`.replace(/\n*$/, "");
        out = `${base}\n\n`;
        cursor = line.start;
      }
      droppedPage = false;
      continue;
    }
    out += chunk.slice(cursor, line.start);
    cursor = line.end;
    if (BARE_NUM.test(line.text.trim())) droppedPage = true;
    else if (line.text.trim()) droppedPage = false;
  }
  out += chunk.slice(cursor);
  return out;
}

/**
 * Keep clutter and reference drops. Restore protected reading lines instead
 * of discarding the whole drop list. A chunk that is only clutter may be
 * emptied down to a single kept line.
 */
export function acceptListenOps(
  chunk: string,
  ops: ListenOps,
  opts?: { headerTexts?: Set<string>; strict?: boolean }
): { text: string; accepted: boolean; dropIds: number[] } {
  const lines = lineSpans(chunk);
  if (ops.drop.length === 0 || lines.length === 0) {
    return { text: chunk, accepted: true, dropIds: [] as number[] };
  }
  const opening = lines.find((line) => line.text.trim());
  const permit = permittedModelDropIds(lines, opts?.headerTexts ?? runningHeaderTexts(lines, 2), {
    strict: opts?.strict,
  });
  const protectedIds = new Set(
    lines
      .filter((line) => {
        if (permit.has(line.id)) return false;
        return (
          isProtectedReadingLine(line.text) ||
          (line.id === opening?.id && isBookTitleLine(line.text))
        );
      })
      .map((line) => line.id)
  );
  let drop = ops.drop.filter((id) => !protectedIds.has(id));
  const readable = lines.filter((line) => line.text.trim());
  const bySize = [...drop].sort((a, b) => {
    const la = lines.find((line) => line.id === a);
    const lb = lines.find((line) => line.id === b);
    return (la ? la.end - la.start : 0) - (lb ? lb.end - lb.start : 0);
  });
  while (drop.length > 0 && drop.length >= readable.length) {
    const shed = bySize.find((id) => drop.includes(id));
    if (shed == null) break;
    drop = drop.filter((id) => id !== shed);
  }

  if (drop.length === 0) return { text: chunk, accepted: false, dropIds: [] as number[] };
  if (
    !isIndexLikeChunk(chunk) &&
    dropShare(chunk, drop) > LISTEN_PREP_MAX_DROP_SHARE
  ) {
    return { text: chunk, accepted: false, dropIds: [] as number[] };
  }
  const text = applyListenOps(chunk, { ...ops, drop });
  if (!text.trim()) return { text: chunk, accepted: false, dropIds: [] as number[] };
  return { text, accepted: true, dropIds: drop };
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  if (items.length === 0) return out;
  let next = 0;
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (true) {
        const i = next;
        next += 1;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!, i);
      }
    })
  );
  return out;
}

async function cleanChunk(opts: {
  chunk: string;
  index: number;
  chunkCount: number;
  model: string;
  apiKey: string;
  timeoutMs: number;
  fetchFn: ListenPrepFetch;
  headerTexts?: Set<string>;
}): Promise<{
  text: string;
  dropped: number;
  failOpen: boolean;
  rejected: boolean;
  sample: string;
  note: ListenNote | null;
  ms: number;
  fallback: boolean;
  ok: boolean;
}> {
  const started = Date.now();
  const spans = lineSpans(opts.chunk);
  const prepassRaw = prepassDropIds(spans);
  const prepassIds = guardDropIds(opts.chunk, prepassRaw, [], prepassRaw);
  const prepassText =
    prepassIds.length === 0
      ? opts.chunk
      : applyListenOps(opts.chunk, { drop: prepassIds, headings: [] });
  const unchanged = {
    text: prepassText.trim() ? prepassText : opts.chunk,
    dropped: prepassText.trim() ? prepassIds.length : 0,
    failOpen: true,
    rejected: false,
    sample: "",
    note: null as ListenNote | null,
    ms: 0,
    fallback: false,
    ok: false,
  };
  const finish = (
    row: Omit<typeof unchanged, "ms">
  ): typeof unchanged => ({ ...row, ms: Date.now() - started });
  try {
    const posted = await postListenChunk({
      chunk: opts.chunk,
      model: opts.model,
      fallbackModel: listenPrepFallbackModel(),
      apiKey: opts.apiKey,
      timeoutMs: opts.timeoutMs,
      fetchFn: opts.fetchFn,
    });
    if (!posted) return finish(unchanged);
    const ops = posted.ops;
    const guarded = withoutProseDrops(opts.chunk, ops);
    const applied = acceptListenOps(opts.chunk, guarded, {
      headerTexts: opts.headerTexts,
      strict: posted.fallback,
    });
    const modelIds = applied.accepted ? applied.dropIds : [];
    const permit = permittedModelDropIds(spans, opts.headerTexts ?? runningHeaderTexts(spans, 2), {
      strict: posted.fallback,
    });
    const union = guardDropIds(
      opts.chunk,
      [...new Set([...modelIds, ...prepassIds])],
      ops.headings,
      [...permit].filter((id) => modelIds.includes(id))
    );
    const overCap =
      union.length > 0 &&
      !isIndexLikeChunk(opts.chunk) &&
      dropShare(opts.chunk, union) > LISTEN_PREP_MAX_DROP_SHARE;
    const dropIds = overCap ? [] : union;
    const merged = dropIds.length
      ? applyListenOps(opts.chunk, { drop: dropIds, headings: ops.headings })
      : opts.chunk;
    const text = merged.trim() ? merged : unchanged.text;
    if (!applied.accepted) {
      return finish({
        ...unchanged,
        text,
        dropped: dropIds.length,
        failOpen: false,
        rejected: true,
        note: ops.note ?? null,
        fallback: posted.fallback,
        ok: !posted.fallback,
      });
    }
    const lines = lineSpans(opts.chunk);
    const sample =
      lines.find((line) => dropIds.includes(line.id))?.text.replace(/\s+/g, " ").trim().slice(0, 80) ||
      "";
    return finish({
      text,
      dropped: dropIds.length,
      failOpen: false,
      rejected: overCap || (!applied.accepted && prepassIds.length > 0),
      sample,
      note: ops.note ?? null,
      fallback: posted.fallback,
      ok: !posted.fallback,
    });
  } catch {
    return finish(unchanged);
  }
}

async function opsFromResponse(res: Response, lineCount: number): Promise<ListenOps | null> {
  try {
    return coerceListenOps(unwrapJson(messageContent(await res.json())), lineCount);
  } catch {
    return null;
  }
}

async function postListenChunk(opts: {
  chunk: string;
  model: string;
  fallbackModel: string;
  apiKey: string;
  timeoutMs: number;
  fetchFn: ListenPrepFetch;
}): Promise<{ ops: ListenOps; fallback: boolean } | null> {
  const lineCount = lineSpans(opts.chunk).length;
  const primary = await postRoute(opts, opts.model, "primary");
  if (primary?.ok) {
    const ops = await opsFromResponse(primary, lineCount);
    if (ops) return { ops, fallback: false };
  }
  const fallback = await postRoute(opts, opts.fallbackModel, "fallback");
  if (fallback?.ok) {
    const ops = await opsFromResponse(fallback, lineCount);
    if (ops) return { ops, fallback: true };
  }
  return null;
}

async function postRoute(
  opts: {
    chunk: string;
    apiKey: string;
    timeoutMs: number;
    fetchFn: ListenPrepFetch;
  },
  model: string,
  route: "primary" | "fallback"
): Promise<Response | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await withGlobalSlot(() =>
        opts.fetchFn(OPENROUTER_CHAT_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer":
              process.env.NEXT_PUBLIC_APP_URL || "https://echomancer.xyz",
            "X-Title": "Echomancer listen prep",
          },
          body: JSON.stringify(listenPrepRequestBody(model, opts.chunk, route)),
          signal: AbortSignal.timeout(opts.timeoutMs),
        })
      );
      if (res.ok) return res;
      if (attempt === 0 && (res.status === 429 || res.status >= 500)) {
        await sleep(listenPrepRetryMs());
        continue;
      }
      return res;
    } catch {
      return null;
    }
  }
  return null;
}

export function listenPrepRequestBody(
  model: string,
  chunk: string,
  route: "primary" | "fallback"
) {
  return {
    model,
    temperature: 0,
    max_tokens: LISTEN_PREP_OUTPUT_TOKENS,
    reasoning: route === "primary" ? { effort: "minimal" } : { enabled: false },
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "listen_prep",
        strict: true,
        schema: LISTEN_PREP_SCHEMA,
      },
    },
    provider: route === "primary" ? PRIMARY_PROVIDER : FALLBACK_PROVIDER,
    messages: [
      { role: "system", content: listenPrepSystemPrompt() },
      { role: "user", content: numberedChunk(chunk) },
    ],
  };
}

const LISTEN_PREP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    drop: { type: "array", items: { type: "string" } },
    headings: { type: "array", items: { type: "string" } },
    note: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: ["string", "null"] },
        novelKind: { type: ["string", "null"] },
        tone: { type: "string" },
        pov: { type: "string" },
        dialogue: { type: ["string", "null"] },
      },
      required: ["kind", "novelKind", "tone", "pov", "dialogue"],
    },
  },
  required: ["drop", "headings", "note"],
} as const;

let globalActive = 0;
const globalWaiters: Array<() => void> = [];

async function withGlobalSlot<T>(fn: () => Promise<T>): Promise<T> {
  const limit = listenPrepGlobalConcurrency();
  if (globalActive >= limit) {
    await new Promise<void>((resolve) => globalWaiters.push(resolve));
  }
  globalActive += 1;
  try {
    return await fn();
  } finally {
    globalActive -= 1;
    globalWaiters.shift()?.();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fail-open per chunk. No key leaves the book untouched. */
export async function prepareForListening(
  rawText: string,
  opts?: {
    fetch?: ListenPrepFetch;
    apiKey?: string;
    model?: string;
    concurrency?: number;
    timeoutMs?: number;
    /** Successful chunks from an earlier pass. Those indexes are not sent again. */
    prior?: ListenChunkRecord[];
  }
): Promise<ListenPrepResult> {
  const text = rawText ?? "";
  const model = opts?.model || listenPrepModel();
  const empty: ListenPrepResult = {
    text,
    droppedLines: 0,
    failOpenChunks: 0,
    rejectedChunks: 0,
    chunkCount: 0,
    wallMs: 0,
    p50Ms: 0,
    maxMs: 0,
    model,
    fallbackChunks: 0,
    notes: [],
    sample: "",
    chunks: [],
  };
  if (!text.trim()) return empty;
  const apiKey = opts?.apiKey ?? getOpenRouterApiKey();
  if (!apiKey) return { ...empty, text: deterministicPrepass(text) };
  const chunks = splitListenChunks(text);
  if (chunks.length === 0) return empty;
  const headerTexts = runningHeaderTexts(lineSpans(text), 2);
  const fetchFn = opts?.fetch ?? fetch;
  const started = Date.now();
  const prior = opts?.prior;
  const cleaned = await mapPool(
    chunks,
    opts?.concurrency ?? listenPrepConcurrency(),
    (chunk, index) => {
      const saved = prior?.[index];
      if (saved?.ok && prior?.length === chunks.length) {
        return Promise.resolve({
          text: saved.text,
          dropped: 0,
          failOpen: false,
          rejected: false,
          sample: "",
          note: saved.note,
          ms: 0,
          fallback: false,
          ok: true,
        });
      }
      return cleanChunk({
        chunk,
        index,
        chunkCount: chunks.length,
        model,
        apiKey,
        timeoutMs: opts?.timeoutMs ?? listenPrepChunkTimeoutMs(),
        fetchFn,
        headerTexts,
      });
    }
  );
  const latencies = cleaned.map((chunk) => chunk.ms).sort((a, b) => a - b);
  const mid = latencies[Math.floor((latencies.length - 1) / 2)] ?? 0;
  let joined = cleaned.map((chunk) => chunk.text).join("");
  if (!joined.trim()) joined = text;
  return {
    text: joined,
    droppedLines: cleaned.reduce((sum, chunk) => sum + chunk.dropped, 0),
    failOpenChunks: cleaned.filter((chunk) => chunk.failOpen).length,
    rejectedChunks: cleaned.filter((chunk) => chunk.rejected).length,
    chunkCount: cleaned.length,
    wallMs: Date.now() - started,
    p50Ms: mid,
    maxMs: latencies[latencies.length - 1] ?? 0,
    model,
    fallbackChunks: cleaned.filter((chunk) => chunk.fallback).length,
    notes: cleaned.flatMap((chunk) => (chunk.note ? [chunk.note] : [])),
    sample: cleaned.find((chunk) => chunk.sample)?.sample || "",
    chunks: cleaned.map((chunk) => ({ ok: chunk.ok, text: chunk.text, note: chunk.note })),
  };
}
