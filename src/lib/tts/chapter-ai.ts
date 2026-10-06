/**
 * AI chapter detection.
 *
 * The owner-asked design: an LLM reads the body text and lists each chapter
 * (plus clear sub-chapters) as a title plus the verbatim opening words of
 * its first paragraph. Those opening words are located in the extracted text
 * (exact, then whitespace/punctuation/case-insensitive, then a small fuzzy
 * match) to get char offsets. Timing reuses the existing MP3-frame /
 * speakable-text path (`timePlaybackTree`), so this module only produces
 * the `chapters.json` shape the player already reads.
 *
 * Runs on the always-on worker only (extract child `host: "node"`, freeze
 * and rechapter `host: "worker"`), never inside a Vercel function. The
 * default model follows the cleanup model (`LISTEN_PREP_MODEL`) and is
 * overridden with `CHAPTER_AI_MODEL`. No key, no budget, or a failed call
 * returns null and the caller keeps the heuristic outline. The old
 * embedding / title-matching code stays behind its own flags.
 */

import {
  chapterDisplayTitle,
  chaptersForNarration,
  withPartContextTitles,
  type BookChapter,
  type ChapterHint,
  type ChaptersDocument,
} from "@/lib/book-chapters";
import {
  listenPrepModel,
  listenPrepProvider,
} from "@/lib/tts/listen-prep";
import { getOpenRouterApiKey } from "@/lib/tts/providers/openrouter";

export const CHAPTER_AI_SOURCE = "ai" as const;
/** Windows of about this many characters are sent per model call. */
export const DEFAULT_CHAPTER_AI_WINDOW_CHARS = 150_000;
export const MIN_CHAPTER_AI_WINDOW_CHARS = 50_000;
export const MAX_CHAPTER_AI_WINDOW_CHARS = 200_000;
/** Trailing overlap so a chapter straddling a cut is seen twice (deduped). */
export const CHAPTER_AI_WINDOW_OVERLAP_CHARS = 5_000;
export const DEFAULT_CHAPTER_AI_CONCURRENCY = 4;
export const MAX_CHAPTER_AI_CONCURRENCY = 8;
/** Per window attempt. One retry on 429/5xx, then the window is skipped. */
export const DEFAULT_CHAPTER_AI_TIMEOUT_MS = 60_000;
export const CHAPTER_AI_RETRY_MS = 2_500;
/** Whole-book wall clock. A 2.5M-char book is ~17 windows. */
export const DEFAULT_CHAPTER_AI_BUDGET_MS = 300_000;
/** Two hits this close together are the same chapter seen twice. */
export const CHAPTER_AI_DEDUPE_CHARS = 200;
/** Books shorter than this keep the heuristic outline (no model call). */
export const CHAPTER_AI_MIN_CHARS = 1_000;

const CHAT_URL =
  (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "") +
  "/chat/completions";

export type ChapterAiHost = "node" | "worker" | "inline" | "cloudflare";

export function chapterAiModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.CHAPTER_AI_MODEL?.trim() || listenPrepModel(env);
}

function readApiKey(env: NodeJS.ProcessEnv, optsKey?: string): string | undefined {
  if (optsKey?.trim()) return optsKey.trim();
  if (env === process.env) return getOpenRouterApiKey();
  return env.OPENROUTER_API_KEY || env.OPEN_ROUTER_API_KEY || undefined;
}

/** Default chapter source when a key exists. `CHAPTER_AI_ENABLED=0` opts out. */
export function chapterAiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CHAPTER_AI_ENABLED?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no") return false;
  const key = readApiKey(env);
  return !!key?.trim();
}

/**
 * Worker-only gate. Vercel (`VERCEL=1`) and the Vercel/Cloudflare extract
 * fallbacks (`inline` / `cloudflare`) never run the model; the VM extract
 * child (`node`) and freeze/rechapter (`worker`) do.
 */
export function chapterAiAllowedHere(
  host: ChapterAiHost | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (env.VERCEL === "1") return false;
  return host === "node" || host === "worker";
}

export function chapterAiWindowChars(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.CHAPTER_AI_WINDOW_CHARS);
  if (Number.isFinite(n)) {
    return Math.min(
      MAX_CHAPTER_AI_WINDOW_CHARS,
      Math.max(MIN_CHAPTER_AI_WINDOW_CHARS, Math.floor(n))
    );
  }
  return DEFAULT_CHAPTER_AI_WINDOW_CHARS;
}

export function chapterAiConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.CHAPTER_AI_CONCURRENCY);
  if (Number.isFinite(n) && n >= 1 && n <= MAX_CHAPTER_AI_CONCURRENCY) return Math.floor(n);
  return DEFAULT_CHAPTER_AI_CONCURRENCY;
}

export function chapterAiTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.CHAPTER_AI_TIMEOUT_MS);
  if (Number.isFinite(n) && n >= 15_000 && n <= 120_000) return Math.floor(n);
  return DEFAULT_CHAPTER_AI_TIMEOUT_MS;
}

export function chapterAiBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.CHAPTER_AI_BUDGET_MS);
  if (Number.isFinite(n) && n >= 30_000 && n <= 900_000) return Math.floor(n);
  return DEFAULT_CHAPTER_AI_BUDGET_MS;
}

export interface ChapterWindow {
  index: number;
  start: number;
  end: number;
  text: string;
}

function paragraphSpans(text: string): { text: string; start: number }[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const spans: { text: string; start: number }[] = [];
  const re = /\n\s*\n/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(normalized))) {
    spans.push({ text: normalized.slice(start, match.index), start });
    start = match.index + match[0].length;
  }
  spans.push({ text: normalized.slice(start), start });
  return spans;
}

/**
 * Split on paragraph boundaries into windows of ~`targetChars`, each tagged
 * with its char offset. Consecutive windows overlap so a chapter on the cut
 * is reported twice and deduped by offset.
 */
export function splitChapterWindows(
  text: string,
  targetChars: number = DEFAULT_CHAPTER_AI_WINDOW_CHARS,
  overlapChars: number = CHAPTER_AI_WINDOW_OVERLAP_CHARS
): ChapterWindow[] {
  if (!text) return [];
  const target = Math.min(
    MAX_CHAPTER_AI_WINDOW_CHARS,
    Math.max(MIN_CHAPTER_AI_WINDOW_CHARS, Math.floor(targetChars) || DEFAULT_CHAPTER_AI_WINDOW_CHARS)
  );
  if (text.length <= target) {
    return [{ index: 0, start: 0, end: text.length, text }];
  }
  const spans = paragraphSpans(text);
  const windows: ChapterWindow[] = [];
  let first = 0;
  while (first < spans.length) {
    let end = text.length;
    let chars = 0;
    let last = first;
    for (let i = first; i < spans.length; i++) {
      chars += spans[i]!.text.length + 2;
      last = i;
      if (chars >= target) {
        end = spans[i]!.start + spans[i]!.text.length;
        break;
      }
    }
    const start = spans[first]!.start;
    windows.push({
      index: windows.length,
      start,
      end: Math.min(text.length, end),
      text: text.slice(start, Math.min(text.length, end)),
    });
    if (last >= spans.length - 1) break;
    const cutAt = Math.min(text.length, end);
    let next = last + 1;
    while (next > first && spans[next]!.start > cutAt - overlapChars) next -= 1;
    first = Math.min(last + 1, next + 1);
    if (first <= windows[windows.length - 1]!.start) first = last + 1;
  }
  return windows;
}

export interface AiChapterHint {
  title: string;
  level: number;
  opening: string;
}

function tocHintLabels(hint: ChapterHint): string[] {
  const fromToc = (hint.tocLines ?? []).slice(0, 40).map((line) =>
    line.replace(/\s+/g, " ").trim()
  );
  if (fromToc.length >= 2) return fromToc;
  return hint.titles
    .slice(0, 40)
    .map((title) => title.title.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

export function chapterAiPrompt(
  window: ChapterWindow,
  totalChars: number,
  tocLabels: string[]
): string {
  return [
    "You list chapter boundaries for an audiobook. Read the book text below and reply with JSON only.",
    `This window is characters ${window.start}-${window.end} of ${totalChars}.`,
    'Reply {"chapters":[{"title":"...","level":1,"opening":"..."}]} in document order.',
    "List each chapter and each clear sub-chapter or part. level is 1 for chapters and parts, 2 for sub-sections inside them.",
    "title is the chapter heading as printed (for example \"Chapter One\" or \"The Awakening\"). Keep it short.",
    "opening is the first 8-15 words of the chapter's first body paragraph, copied EXACTLY as printed, word for word.",
    "Decide from the body text. A contents list is only a hint and is never itself a chapter.",
    "Ignore the contents page, running headers and footers, page numbers, index entries, footnotes and endnotes, and copyright or ISBN pages, unless one of them is a real section of the book.",
    'A window with no chapter start returns {"chapters":[]}.',
    tocLabels.length
      ? `Possible titles from the printed contents (hint only, never copy rows as chapters): ${tocLabels.join(" | ")}`
      : "",
    "Book text:",
    window.text,
  ]
    .filter(Boolean)
    .join("\n");
}

function unwrapJson(raw: string): unknown {
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) text = fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  return JSON.parse(text);
}

/** Model rows that can be located. Openings under 3 words are dropped. */
export function parseWindowChapters(content: string): AiChapterHint[] {
  let parsed: unknown;
  try {
    parsed = unwrapJson(content);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const rows = (parsed as { chapters?: unknown }).chapters;
  if (!Array.isArray(rows)) return [];
  const out: AiChapterHint[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as { title?: unknown; level?: unknown; opening?: unknown };
    const title = typeof record.title === "string" ? record.title.replace(/\s+/g, " ").trim() : "";
    const opening =
      typeof record.opening === "string" ? record.opening.replace(/\s+/g, " ").trim() : "";
    if (!title || opening.split(" ").filter(Boolean).length < 3) continue;
    const level = record.level === 2 ? 2 : 1;
    out.push({ title: title.slice(0, 200), level, opening: opening.slice(0, 500) });
  }
  return out;
}

type FoldedText = {
  folded: string;
  /** Original char offset for each folded char. */
  map: number[];
  words: { word: string; foldedStart: number }[];
  byWord: Map<string, number[]>;
};

function foldChar(ch: string): string | null {
  if (/[\p{L}\p{N}]/u.test(ch)) return ch.toLowerCase();
  if (/\s/u.test(ch)) return " ";
  return " ";
}

/** Lowercase, punctuation- and whitespace-insensitive fold with offset map. */
export function foldForLocate(text: string, base = 0): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < text.length; i++) {
    const out = foldChar(text[i]!);
    if (out === " ") {
      if (folded.length > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      folded += " ";
      map.push(base + i);
      pendingSpace = false;
    }
    folded += out;
    map.push(base + i);
  }
  return { folded: folded.replace(/ +$/g, ""), map };
}

export function buildFoldedCache(text: string): FoldedText {
  const { folded, map } = foldForLocate(text);
  const words: { word: string; foldedStart: number }[] = [];
  const byWord = new Map<string, number[]>();
  const re = /[^ ]+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(folded))) {
    const index = words.length;
    words.push({ word: match[0], foldedStart: match.index });
    const list = byWord.get(match[0]) ?? [];
    list.push(index);
    byWord.set(match[0], list);
  }
  return { folded, map, words, byWord };
}

function foldedIndexForChar(cache: FoldedText, charOffset: number): number {
  let lo = 0;
  let hi = cache.map.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cache.map[mid]! < charOffset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function wordIndexForFolded(cache: FoldedText, foldedIndex: number): number {
  let lo = 0;
  let hi = cache.words.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cache.words[mid]!.foldedStart < foldedIndex) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Small fuzzy match for a slightly mis-copied opening: substitution-only
 * word overlap of 80%+ over at least 5 words, anchored on distinctive words.
 * Returns the original char offset, or -1.
 */
export function fuzzyLocateOpening(
  cache: FoldedText,
  openingWords: string[],
  fromChar: number
): number {
  const wanted = openingWords.map((word) => word.toLowerCase()).filter(Boolean);
  if (wanted.length < 5) return -1;
  const fromWord = Math.max(
    0,
    wordIndexForFolded(cache, foldedIndexForChar(cache, Math.max(0, fromChar))) - 2
  );
  const distinctive = wanted
    .map((word, i) => ({ word, i }))
    .filter((entry) => entry.word.length >= 5)
    .slice(0, 3);
  const seeds = distinctive.length > 0 ? distinctive : wanted.map((word, i) => ({ word, i }));
  const candidates = new Set<number>();
  for (const seed of seeds) {
    const occurrences = cache.byWord.get(seed.word) ?? [];
    for (const at of occurrences) {
      const start = at - seed.i;
      if (start < fromWord) continue;
      if (start + wanted.length > cache.words.length) continue;
      candidates.add(start);
      if (candidates.size >= 40) break;
    }
    if (candidates.size >= 40) break;
  }
  let best = -1;
  let bestScore = 0;
  for (const start of candidates) {
    let hits = 0;
    for (let j = 0; j < wanted.length; j++) {
      if (cache.words[start + j]!.word === wanted[j]) hits += 1;
    }
    const score = hits / wanted.length;
    if (score > bestScore && score >= 0.8) {
      bestScore = score;
      best = start;
    }
  }
  if (best < 0) return -1;
  const foldedStart = cache.words[best]!.foldedStart;
  return cache.map[foldedStart] ?? -1;
}

/**
 * Locate verbatim opening words in the text: exact first, then a
 * whitespace/punctuation/case-insensitive match, then a small fuzzy match.
 * Searches forward from `from`. Returns the char offset, or -1.
 */
export function locateOpeningWords(
  text: string,
  opening: string,
  from = 0,
  cache?: FoldedText
): number {
  const start = Math.max(0, Math.min(text.length, from));
  const needle = opening.replace(/\s+/g, " ").trim();
  if (needle.length < 3) return -1;
  const exact = text.indexOf(needle, start);
  if (exact >= 0) return exact;
  const folded = cache ?? buildFoldedCache(text);
  const { folded: wantFolded } = foldForLocate(needle);
  if (wantFolded.length >= 3) {
    const fromFolded = foldedIndexForChar(folded, start);
    const at = folded.folded.indexOf(wantFolded, fromFolded);
    if (at >= 0) {
      const pos = folded.map[at];
      if (pos != null) return pos;
    }
  }
  return fuzzyLocateOpening(folded, wantFolded.split(" "), start);
}

function paragraphStartAt(text: string, offset: number): number {
  const at = Math.max(0, Math.min(text.length, Math.floor(offset)));
  if (at <= 0) return 0;
  const head = text.slice(0, at);
  const breaks = /\n[ \t]*\n/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = breaks.exec(head))) start = match.index + match[0].length;
  while (start < at && (text[start] === " " || text[start] === "\t")) start += 1;
  return start;
}

function normTitleKey(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[.!?…\s]+$/u, "");
}

export interface LocatedChapter extends AiChapterHint {
  charStart: number;
  /** Verbatim source line for packing (title line, or the opening excerpt). */
  match: string;
  windowIndex: number;
}

/**
 * Prefer the title line: when the paragraph just above the located opening
 * is the chapter's heading, the chapter starts there. Otherwise the chapter
 * starts at the opening words and `match` is the opening excerpt.
 */
export function snapChapterStart(
  text: string,
  openingOffset: number,
  aiTitle: string
): { charStart: number; match: string } {
  const paraStart = paragraphStartAt(text, openingOffset);
  const head = text.slice(0, paraStart).replace(/\s+$/g, "");
  let prevStart = 0;
  const re = /\n[ \t]*\n/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(head))) {
    let start = match.index + match[0].length;
    while (start < head.length && (head[start] === " " || head[start] === "\t")) start += 1;
    prevStart = start;
  }
  const prevText = head.slice(prevStart).replace(/\s+/g, " ").trim();
  const titleKey = normTitleKey(aiTitle);
  const prevKey = normTitleKey(prevText);
  const titleMatch =
    prevText.length > 0 &&
    prevText.length <= 120 &&
    prevKey.length >= 2 &&
    titleKey.length >= 2 &&
    (prevKey === titleKey || prevKey.startsWith(titleKey) || titleKey.startsWith(prevKey));
  if (titleMatch) {
    return { charStart: prevStart, match: prevText };
  }
  const openingPara = text.slice(paraStart).split(/\n\s*\n/)[0] ?? "";
  const excerpt = openingPara.replace(/\s+/g, " ").trim().slice(0, 120);
  return { charStart: paraStart, match: excerpt || aiTitle.slice(0, 120) };
}

/**
 * Merge window results into document order. Entries whose opening words
 * cannot be located are dropped. The same chapter reported by overlapping
 * windows (offsets within `CHAPTER_AI_DEDUPE_CHARS`, same title) is kept
 * once.
 */
export function mergeLocatedChapters(found: LocatedChapter[]): LocatedChapter[] {
  const ordered = [...found]
    .filter((entry) => entry.charStart >= 0)
    .sort((a, b) => a.charStart - b.charStart || a.windowIndex - b.windowIndex);
  const kept: LocatedChapter[] = [];
  for (const entry of ordered) {
    const last = kept[kept.length - 1];
    if (
      last &&
      entry.charStart - last.charStart <= CHAPTER_AI_DEDUPE_CHARS &&
      normTitleKey(entry.title) === normTitleKey(last.title)
    ) {
      continue;
    }
    kept.push(entry);
  }
  return kept;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function completeWindow(
  apiKey: string,
  model: string,
  prompt: string,
  fetchFn: typeof fetch,
  timeoutMs: number
): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchFn(CHAT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL || "https://echomancer.xyz",
          "X-Title": "Echomancer chapter detection",
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [{ role: "user", content: prompt }],
          provider: listenPrepProvider(model, "primary"),
          response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
          await sleep(CHAPTER_AI_RETRY_MS);
          continue;
        }
        return null;
      }
      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = body.choices?.[0]?.message?.content;
      return typeof content === "string" && content.trim() ? content : null;
    } catch {
      return null;
    }
  }
  return null;
}

export interface ResolveAiOptions {
  fetch?: typeof fetch;
  apiKey?: string;
  /** `node` (VM extract child) or `worker` (freeze / rechapter). Others skip. */
  host?: ChapterAiHost;
  model?: string;
  concurrency?: number;
  timeoutMs?: number;
  windowChars?: number;
  budgetMs?: number;
  /** Texts shorter than this keep the heuristic outline. Defaults to 1000. */
  minChars?: number;
}

/**
 * Run AI chapter detection over the book text. Returns a `chapters.json`
 * document with `source: "ai"`, or null when the model is disabled,
 * disallowed here, or unusable — the caller falls back to the heuristic
 * outline.
 */
export async function resolveAiChapters(
  spoken: string,
  hint: ChapterHint,
  opts: ResolveAiOptions = {}
): Promise<ChaptersDocument | null> {
  const env = process.env;
  const apiKey = opts.apiKey ?? readApiKey(env);
  if (!apiKey?.trim()) return null;
  if (!chapterAiAllowedHere(opts.host, env)) return null;
  if (env.CHAPTER_AI_ENABLED?.trim().toLowerCase() === "0") return null;
  const minChars = opts.minChars ?? CHAPTER_AI_MIN_CHARS;
  if (!spoken || spoken.trim().length < minChars) return null;
  const model = opts.model ?? chapterAiModel(env);
  const windowChars = opts.windowChars ?? chapterAiWindowChars(env);
  const concurrency = Math.min(
    MAX_CHAPTER_AI_CONCURRENCY,
    Math.max(1, opts.concurrency ?? chapterAiConcurrency(env))
  );
  const timeoutMs = opts.timeoutMs ?? chapterAiTimeoutMs(env);
  const budgetMs = opts.budgetMs ?? chapterAiBudgetMs(env);
  const fetchFn = opts.fetch ?? fetch;
  const budget = AbortSignal.timeout(budgetMs);

  const windows = splitChapterWindows(spoken, windowChars);
  if (windows.length === 0) return null;
  const tocLabels = tocHintLabels(hint);
  const cache = buildFoldedCache(spoken);

  let located: LocatedChapter[] = [];
  try {
    const perWindow = await mapPool(windows, concurrency, async (window) => {
      if (budget.aborted) return [] as LocatedChapter[];
      const content = await completeWindow(
        apiKey.trim(),
        model,
        chapterAiPrompt(window, spoken.length, tocLabels),
        fetchFn,
        timeoutMs
      );
      if (!content || budget.aborted) return [] as LocatedChapter[];
      const rows = parseWindowChapters(content);
      const out: LocatedChapter[] = [];
      const searchFrom = Math.max(0, window.start - CHAPTER_AI_WINDOW_OVERLAP_CHARS);
      for (const row of rows) {
        const at = locateOpeningWords(spoken, row.opening, searchFrom, cache);
        if (at < 0) continue;
        const snapped = snapChapterStart(spoken, at, row.title);
        out.push({ ...row, charStart: snapped.charStart, match: snapped.match, windowIndex: window.index });
      }
      return out;
    });
    located = mergeLocatedChapters(perWindow.flat());
  } catch {
    return null;
  }
  if (located.length === 0) return null;

  const flat: BookChapter[] = located.map((entry, i) => ({
    index: i,
    title: chapterDisplayTitle(entry.title),
    level: entry.level,
    charStart: entry.charStart,
    charEnd: spoken.length,
    match: entry.match,
  }));
  const titles = withPartContextTitles(flat.map((chapter) => chapter.title));
  const contextual = flat.map((chapter, i) =>
    titles[i] === chapter.title ? chapter : { ...chapter, title: titles[i]! }
  );
  const narrated = chaptersForNarration(contextual, spoken);
  if (narrated.length === 0) return null;
  const chapters = nestAiChapters(narrated, spoken.length);
  if (chapters.length === 0) return null;
  return { version: 1, source: CHAPTER_AI_SOURCE, chapters };
}

function nestAiChapters(chapters: BookChapter[], textLength: number): BookChapter[] {
  const capped = chapters.slice(0, 400);
  const roots: BookChapter[] = [];
  const stack: BookChapter[] = [];
  for (const chapter of capped) {
    const node: BookChapter = { ...chapter };
    delete node.children;
    while (stack.length > 0 && stack[stack.length - 1]!.level >= node.level) stack.pop();
    const parent = stack[stack.length - 1];
    if (!parent) roots.push(node);
    else {
      parent.children = parent.children ?? [];
      parent.children.push(node);
    }
    stack.push(node);
  }
  const finish = (nodes: BookChapter[], end: number): BookChapter[] => {
    const limited = nodes.slice(0, 400);
    for (let i = 0; i < limited.length; i++) {
      const nextStart = limited[i + 1]?.charStart ?? end;
      const children = limited[i]!.children?.length
        ? finish(limited[i]!.children!, nextStart)
        : undefined;
      limited[i] = {
        ...limited[i]!,
        index: i,
        charEnd: nextStart,
        ...(children && children.length > 0 ? { children } : {}),
      };
      if (!children?.length) delete limited[i]!.children;
    }
    return limited;
  };
  return finish(roots, textLength);
}
