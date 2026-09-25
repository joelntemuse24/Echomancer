/**
 * Whole-book listen cleanup before a take-home script is frozen.
 *
 * The book is split into chunks of about 8k tokens and cleaned in parallel.
 * The model returns ids only: lines to drop, and lines that are headings.
 * Kept text is the original bytes with those lines removed. A timeout, bad
 * JSON, or an implausible drop share leaves that chunk unchanged.
 */

import { getOpenRouterApiKey } from "@/lib/tts/providers/openrouter";

export const DEFAULT_LISTEN_PREP_MODEL = "deepseek/deepseek-v4.1-flash";
/** About 4 characters per token. Target ~8k tokens, hard cap ~10k. */
export const LISTEN_PREP_CHARS_PER_TOKEN = 4;
export const LISTEN_PREP_TARGET_TOKENS = 8_000;
export const LISTEN_PREP_MAX_TOKENS = 10_000;
export const LISTEN_PREP_TARGET_CHARS =
  LISTEN_PREP_TARGET_TOKENS * LISTEN_PREP_CHARS_PER_TOKEN;
export const LISTEN_PREP_MAX_CHARS =
  LISTEN_PREP_MAX_TOKENS * LISTEN_PREP_CHARS_PER_TOKEN;
export const DEFAULT_LISTEN_PREP_CONCURRENCY = 8;
export const DEFAULT_LISTEN_PREP_CHUNK_TIMEOUT_MS = 20_000;
export const LISTEN_PREP_OUTPUT_TOKENS = 1_024;
/** Every chunk, including front and back matter, stays under this drop share. */
export const LISTEN_PREP_MAX_DROP_SHARE = 0.4;

const CLUTTER_LINE =
  /copyright|all rights reserved|\bisbn\b|cataloging|table of contents|^contents$|permission|published by|\bindex\b|footnote|^\d{1,4}$/i;

const OPENROUTER_CHAT_URL =
  (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(
    /\/+$/,
    ""
  ) + "/chat/completions";

const LISTEN_PREP_PROVIDER = {
  only: ["deepseek"],
  allow_fallbacks: false,
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
  notes: ListenNote[];
  /** First dropped line, trimmed, for the job log. */
  sample: string;
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

export function listenPrepSystemPrompt(): string {
  return [
    "You clean one chunk of a book so it can be read aloud.",
    "Each line is numbered. Do not rewrite, spell, or punctuate anything. Do not add words.",
    "Answer immediately. No reasoning. One JSON object only, no markdown.",
    '{"drop":number[],"headings":number[]}',
    "drop: line ids that are not for reading. Page numbers, running headers and footers, copyright, ISBN, cataloging-in-publication, permissions, table of contents, index, footnote reference markers, stray artifacts, and publisher ads.",
    "Keep dedications and epigraphs. Keep forewords, prefaces, and the book itself.",
    "headings: line ids that are titles or chapter headings and should be spoken as a heading.",
    'note: a few words about this chunk only. {"kind":"article"|"biography"|"history"|"nonfiction"|"novel"|null,"novelKind":string|null,"tone":string,"pov":string,"dialogue":"low"|"medium"|"high"|null}',
    "If nothing should change, return empty arrays.",
  ].join(" ");
}

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
    .map((line) => `${line.id}\t${line.text}`)
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
    for (const item of raw) {
      const n = typeof item === "number" ? item : Number(item);
      if (!Number.isInteger(n) || n < 1 || n > lineCount) continue;
      if (!out.includes(n)) out.push(n);
    }
    return out;
  };
  if (!Array.isArray(row.drop) && !Array.isArray(row.headings)) return null;
  return { drop: ids(row.drop), headings: ids(row.headings), note: coerceListenNote(row.note) };
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
  for (const line of lines) {
    if (!drop.has(line.id)) continue;
    out += chunk.slice(cursor, line.start);
    cursor = line.end;
  }
  out += chunk.slice(cursor);
  return out;
}

/**
 * Keep clutter drops. Refuse a drop of most reading lines in the body.
 * Every chunk stays under the character cap, and a chunk is never emptied.
 */
export function acceptListenOps(
  chunk: string,
  ops: ListenOps
): { text: string; accepted: boolean } {
  const lines = lineSpans(chunk);
  if (ops.drop.length === 0 || lines.length === 0) {
    return { text: chunk, accepted: true };
  }
  const { bodySentence } = matterLineIds(lines);
  const body = new Set(bodySentence);
  const proseDrops = ops.drop.filter((id) => body.has(id));
  const mostProse =
    bodySentence.length > 0 && proseDrops.length * 2 > bodySentence.length;
  let drop = mostProse
    ? ops.drop.filter((id) => !body.has(id))
    : [...ops.drop];

  const bySize = [...drop].sort((a, b) => {
    const la = lines.find((line) => line.id === a);
    const lb = lines.find((line) => line.id === b);
    return (lb ? lb.end - lb.start : 0) - (la ? la.end - la.start : 0);
  });
  while (drop.length > 0 && dropShare(chunk, drop) > LISTEN_PREP_MAX_DROP_SHARE) {
    const shed = bySize.find((id) => drop.includes(id));
    if (shed == null) break;
    drop = drop.filter((id) => id !== shed);
  }
  while (drop.length > 0 && drop.length >= lines.length) {
    const shed = bySize.find((id) => drop.includes(id));
    if (shed == null) break;
    drop = drop.filter((id) => id !== shed);
  }

  if (drop.length === 0) return { text: chunk, accepted: false };
  const text = applyListenOps(chunk, { ...ops, drop });
  if (!text.trim()) return { text: chunk, accepted: false };
  return { text, accepted: true };
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
}): Promise<{
  text: string;
  dropped: number;
  failOpen: boolean;
  rejected: boolean;
  sample: string;
  note: ListenNote | null;
  ms: number;
}> {
  const started = Date.now();
  const unchanged = {
    text: opts.chunk,
    dropped: 0,
    failOpen: true,
    rejected: false,
    sample: "",
    note: null as ListenNote | null,
    ms: 0,
  };
  const finish = (
    row: Omit<typeof unchanged, "ms">
  ): typeof unchanged => ({ ...row, ms: Date.now() - started });
  try {
    const res = await opts.fetchFn(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer":
          process.env.NEXT_PUBLIC_APP_URL || "https://echomancer.xyz",
        "X-Title": "Echomancer listen prep",
      },
      body: JSON.stringify({
        model: opts.model,
        temperature: 0,
        max_tokens: LISTEN_PREP_OUTPUT_TOKENS,
        reasoning: { effort: "none" },
        provider: LISTEN_PREP_PROVIDER,
        messages: [
          { role: "system", content: listenPrepSystemPrompt() },
          { role: "user", content: numberedChunk(opts.chunk) },
        ],
      }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) return finish(unchanged);
    const ops = coerceListenOps(
      unwrapJson(messageContent(await res.json())),
      lineSpans(opts.chunk).length
    );
    if (!ops) return finish(unchanged);
    const applied = acceptListenOps(opts.chunk, ops);
    if (!applied.accepted) {
      return finish({ ...unchanged, failOpen: false, rejected: true, note: ops.note ?? null });
    }
    const lines = lineSpans(opts.chunk);
    const sample =
      lines.find((line) => ops.drop.includes(line.id))?.text.replace(/\s+/g, " ").trim().slice(0, 80) ||
      "";
    return finish({
      text: applied.text,
      dropped: ops.drop.length,
      failOpen: false,
      rejected: applied.text !== opts.chunk && dropShare(opts.chunk, ops.drop) > LISTEN_PREP_MAX_DROP_SHARE,
      sample,
      note: ops.note ?? null,
    });
  } catch {
    return finish(unchanged);
  }
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
    notes: [],
    sample: "",
  };
  if (!text.trim()) return empty;
  const apiKey = opts?.apiKey ?? getOpenRouterApiKey();
  if (!apiKey) return empty;
  const chunks = splitListenChunks(text);
  if (chunks.length === 0) return empty;
  const fetchFn = opts?.fetch ?? fetch;
  const started = Date.now();
  const cleaned = await mapPool(
    chunks,
    opts?.concurrency ?? listenPrepConcurrency(),
    (chunk, index) =>
      cleanChunk({
        chunk,
        index,
        chunkCount: chunks.length,
        model,
        apiKey,
        timeoutMs: opts?.timeoutMs ?? listenPrepChunkTimeoutMs(),
        fetchFn,
      })
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
    notes: cleaned.flatMap((chunk) => (chunk.note ? [chunk.note] : [])),
    sample: cleaned.find((chunk) => chunk.sample)?.sample || "",
  };
}
