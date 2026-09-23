/**
 * Cheap OpenRouter LLM tagger for Whole-book speakable text (Fish, Edge, Google).
 *
 * One logical pass inserts free-form Fish S2 square-bracket performance cues.
 * The model infers the passage's text type and tags attitude and delivery on
 * the line. There is no emotion allowlist and no book-level seminar prefix.
 * Long books are split on paragraph boundaries and tagged in parallel so the
 * model never has to echo tens of thousands of tokens in 40s (the old
 * one-shot path timed out and fail-opened every run). The section packer
 * then splits. Never rewrites prose. Fail-open per chunk: missing key,
 * timeout, or a rewrite → original chunk. Live Listen never calls this.
 * Edge / Google keep pause IR and strip emotion/tone tags at synth /
 * last-mile mapping. Pins OpenRouter provider to DeepSeek
 * (`only: ["deepseek"]`, no fallbacks) so Flash is not load-balanced across
 * Fireworks / DeepInfra / etc.
 */

import { getOpenRouterApiKey } from "@/lib/tts/providers/openrouter";
import { sanitizeFishS2TaggedText } from "@/lib/tts/fish-s2-cues";

/**
 * Paid-cheap default. Override with FISH_CUE_TAGGER_MODEL. Not a :free slug.
 * The DeepSeek provider pin below still applies regardless of slug.
 */
export const DEFAULT_FISH_CUE_TAGGER_MODEL = "deepseek/deepseek-v4.1-flash";

/**
 * OpenRouter REST `provider` object (snake_case `allow_fallbacks`). Always
 * sent so routing stays on DeepSeek’s own endpoint, even when the model env
 * override points at another DeepSeek slug.
 */
export const FISH_CUE_TAGGER_OPENROUTER_PROVIDER = {
  only: ["deepseek"],
  allow_fallbacks: false,
} as const;

/** Max wait for the whole tagging pass. Return as soon as the model answers. */
export const DEFAULT_FISH_CUE_TAGGER_TIMEOUT_MS = 40_000;
export const MIN_FISH_CUE_TAGGER_TIMEOUT_MS = 1_000;
export const MAX_FISH_CUE_TAGGER_TIMEOUT_MS = 120_000;

/**
 * Target chars per OpenRouter echo. ~3k chars ≈ 800 output tokens — small
 * enough that DeepSeek Flash finishes well inside the per-chunk ceiling.
 */
export const CUE_TAGGER_CHUNK_CHARS = 3_000;
/** Hard ceiling so a single paragraph cannot blow the output budget. */
export const CUE_TAGGER_CHUNK_HARD_CHARS = 3_800;
/** In-flight OpenRouter chat calls for one book. */
export const CUE_TAGGER_PARALLEL = 4;
/** Never ask the model for a 128k echo of the book. */
export const CUE_TAGGER_MAX_OUTPUT_TOKENS = 4_096;
/** Per-chunk abort so one slow shard cannot burn the whole 40s budget. */
export const CUE_TAGGER_CHUNK_TIMEOUT_MS = 12_000;

const OPENROUTER_CHAT_URL = (
  process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1"
).replace(/\/+$/, "") + "/chat/completions";

const MIN_CHARS = 40;

export function fishCueTaggerModel(
  env: NodeJS.ProcessEnv = process.env
): string {
  return env.FISH_CUE_TAGGER_MODEL?.trim() || DEFAULT_FISH_CUE_TAGGER_MODEL;
}

export function isFishCueTaggerEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const raw = env.FISH_CUE_TAGGER;
  if (raw === "0" || raw === "false") return false;
  return Boolean(env.OPENROUTER_API_KEY || env.OPEN_ROUTER_API_KEY);
}

export function fishCueTaggerTimeoutMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const n = Number(env.FISH_CUE_TAGGER_TIMEOUT_MS);
  if (
    Number.isFinite(n) &&
    n >= MIN_FISH_CUE_TAGGER_TIMEOUT_MS &&
    n <= MAX_FISH_CUE_TAGGER_TIMEOUT_MS
  ) {
    return Math.floor(n);
  }
  return DEFAULT_FISH_CUE_TAGGER_TIMEOUT_MS;
}

/** Illustrative cues only. The model may invent any other Fish-style bracket. */
export function fishCueTaggerExampleCues(): string {
  return [
    "Examples, not a closed list:",
    "[aggressive], [cynical], [sarcastic], [matter-of-fact], [deadpan],",
    "[contemptuous], [warm], [resigned], [soft tone], [whispering],",
    "[shouting], [emphasis], [in a hurry], [slightly bitter], [dry aside].",
  ].join(" ");
}

export function fishCueTaggerSystemPrompt(): string {
  return [
    "You insert Fish Audio S2 square-bracket performance cues into narration.",
    "Answer as soon as you can. Do not reason out loud.",
    "Do not rewrite, paraphrase, reorder, add, or delete any words or punctuation.",
    "Keep every existing [break] and [long-break].",
    "Cues are free-form natural language inside square brackets.",
    "Invent any performance, delivery, attitude, or vocal-effect cue that fits the line.",
    "You are not limited to a fixed emotion table.",
    "First infer what kind of text this passage is — academic lecture, nonfiction essay, dialogue-heavy fiction, memoir, technical manual, polemic, satire, or another kind — and let that shape every cue.",
    "Do not print the text type, a genre label, or an explanation, as words or as its own bracket.",
    "Adapt line by line: measured seminar delivery for a lecture, dramatic color for fiction, deadpan matter-of-fact for a manual or a flat report, bite for a polemic or satire.",
    "Do not replace those line cues with one book-level prefix.",
    "Tag attitudes and delivery where the prose warrants them, including layered combinations on the same line: aggression, cynicism, sarcasm, contempt, matter-of-fact calm, warmth, emphasis, whisper, shouting, soft tone, hurry, resignation.",
    "Expressive, argumentative, and dialogue lines should carry cues.",
    "A sentence may take several cues when it holds more than one attitude.",
    fishCueTaggerExampleCues(),
    "Put a cue at the start of a sentence or immediately before the word it colors.",
    "Vocal effects such as laughing, sobbing, sighing, or crowd laughter belong only where the prose depicts that sound.",
    "Output only the tagged text. No markdown, no quotes, no commentary.",
  ].join(" ");
}

export type CueTaggerFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

function openRouterHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer":
      process.env.NEXT_PUBLIC_APP_URL || "https://echomancer.xyz",
    "X-Title": "Echomancer Fish cue tagger",
  };
}

function messageContent(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") {
    return "";
  }
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : part && typeof part === "object" && "text" in part
            ? String((part as { text?: unknown }).text || "")
            : ""
      )
      .join("");
  }
  return "";
}

/**
 * Output is the same prose plus free-form cues. Leave headroom so a dense
 * echo is not truncated — a cut echo fails the prose check and fail-opens.
 */
export function cueTaggerMaxOutputTokens(text: string): number {
  const estimated = Math.ceil(text.length / 3) + 512;
  return Math.min(
    CUE_TAGGER_MAX_OUTPUT_TOKENS,
    Math.max(768, estimated)
  );
}

type CueChunkRange = { start: number; end: number };

function nextBreakOffset(window: string, minPos: number): number {
  const candidates = [". ", "? ", "! ", "\n\n", ".\n", "?\n", "!\n", " "];
  let best = -1;
  for (const token of candidates) {
    const at = window.lastIndexOf(token);
    if (at >= minPos && at > best) best = at + token.length;
  }
  return best;
}

function splitRangeBySize(
  text: string,
  start: number,
  end: number,
  target: number,
  hardMax: number
): CueChunkRange[] {
  const ranges: CueChunkRange[] = [];
  let i = start;
  while (i < end) {
    if (end - i <= hardMax) {
      ranges.push({ start: i, end });
      break;
    }
    const windowEnd = Math.min(i + hardMax, end);
    const window = text.slice(i, windowEnd);
    const minPos = Math.min(target, window.length) - 1;
    const br = nextBreakOffset(window, Math.max(0, Math.floor(minPos * 0.45)));
    const j = br > 0 ? i + br : windowEnd;
    ranges.push({ start: i, end: Math.max(i + 1, j) });
    i = Math.max(i + 1, j);
  }
  return ranges;
}

/**
 * Original-string ranges so tagged chunks can be spliced back without
 * rewriting whitespace (full-book fingerprint must still match).
 */
export function cueTaggerChunkRanges(
  text: string,
  maxChars: number = CUE_TAGGER_CHUNK_CHARS
): CueChunkRange[] {
  const source = text ?? "";
  if (!source) return [];
  const hardMax = Math.max(maxChars, CUE_TAGGER_CHUNK_HARD_CHARS);
  if (source.length <= maxChars) return [{ start: 0, end: source.length }];

  const paras: CueChunkRange[] = [];
  let searchFrom = 0;
  const sep = "\n\n";
  while (searchFrom <= source.length) {
    const idx = source.indexOf(sep, searchFrom);
    if (idx === -1) {
      paras.push({ start: searchFrom, end: source.length });
      break;
    }
    paras.push({ start: searchFrom, end: idx });
    searchFrom = idx + sep.length;
  }

  const ranges: CueChunkRange[] = [];
  let packStart = -1;
  let packEnd = -1;

  const flushPack = () => {
    if (packStart < 0) return;
    const span = packEnd - packStart;
    if (span > hardMax) {
      ranges.push(
        ...splitRangeBySize(source, packStart, packEnd, maxChars, hardMax)
      );
    } else {
      ranges.push({ start: packStart, end: packEnd });
    }
    packStart = -1;
    packEnd = -1;
  };

  for (const para of paras) {
    if (para.end <= para.start) continue;
    if (packStart < 0) {
      packStart = para.start;
      packEnd = para.end;
      continue;
    }
    const nextLen = para.end - packStart;
    if (nextLen <= maxChars) {
      packEnd = para.end;
      continue;
    }
    flushPack();
    packStart = para.start;
    packEnd = para.end;
  }
  flushPack();
  return ranges.length > 0 ? ranges : [{ start: 0, end: source.length }];
}

function spliceTaggedChunks(
  source: string,
  ranges: CueChunkRange[],
  tagged: string[]
): string {
  let out = "";
  let cursor = 0;
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i]!;
    out += source.slice(cursor, range.start);
    out += tagged[i] ?? source.slice(range.start, range.end);
    cursor = range.end;
  }
  out += source.slice(cursor);
  return out;
}

/**
 * Split a frozen speakable into paragraph-packed chunks for parallel tagging.
 * Chunks are exact original slices so the stitch cannot rewrite prose.
 */
export function splitSpeakableForCueTagging(
  text: string,
  maxChars: number = CUE_TAGGER_CHUNK_CHARS
): string[] {
  const source = text ?? "";
  return cueTaggerChunkRanges(source, maxChars).map((r) =>
    source.slice(r.start, r.end)
  );
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

async function completeOpenRouterChat(opts: {
  text: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  fetchFn: CueTaggerFetch;
}): Promise<string> {
  const res = await opts.fetchFn(OPENROUTER_CHAT_URL, {
    method: "POST",
    headers: openRouterHeaders(opts.apiKey),
    body: JSON.stringify({
      model: opts.model,
      temperature: 0,
      max_tokens: cueTaggerMaxOutputTokens(opts.text),
      reasoning: { effort: "none" },
      provider: FISH_CUE_TAGGER_OPENROUTER_PROVIDER,
      messages: [
        {
          role: "system",
          content: fishCueTaggerSystemPrompt(),
        },
        { role: "user", content: opts.text },
      ],
    }),
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `OpenRouter tagger ${res.status}: ${errText.slice(0, 300)}`
    );
  }
  const data = (await res.json()) as unknown;
  return messageContent(data).trim();
}

/**
 * Tag the frozen speakable in **one logical pass**. Long books are chunked
 * and tagged in parallel; callers then run the existing section packer.
 */
export async function tagFishCuesForSpeakable(
  speakable: string,
  opts?: {
    fetch?: CueTaggerFetch;
    model?: string;
    enabled?: boolean;
    timeoutMs?: number;
  }
): Promise<string> {
  const source = speakable ?? "";
  if (!source.trim() || source.trim().length < MIN_CHARS) return source;
  const enabled = opts?.enabled ?? isFishCueTaggerEnabled();
  if (!enabled) return source;

  const apiKey = getOpenRouterApiKey();
  if (!apiKey) return source;

  const fetchFn = opts?.fetch ?? fetch;
  const model = opts?.model || fishCueTaggerModel();
  const timeoutMs = opts?.timeoutMs ?? fishCueTaggerTimeoutMs();
  const ranges = cueTaggerChunkRanges(source);
  const chunks = ranges.map((r) => source.slice(r.start, r.end));
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  let failOpenChunks = 0;

  try {
    const taggedChunks = await mapPool(
      chunks,
      CUE_TAGGER_PARALLEL,
      async (chunk) => {
        const remaining = deadline - Date.now();
        if (remaining < 400) {
          failOpenChunks += 1;
          return chunk;
        }
        const chunkTimeout = Math.max(
          400,
          Math.min(remaining, CUE_TAGGER_CHUNK_TIMEOUT_MS, timeoutMs)
        );
        try {
          const raw = await completeOpenRouterChat({
            text: chunk,
            model,
            apiKey,
            timeoutMs: chunkTimeout,
            fetchFn,
          });
          if (!raw) {
            failOpenChunks += 1;
            return chunk;
          }
          return sanitizeFishS2TaggedText(chunk, raw);
        } catch (err) {
          failOpenChunks += 1;
          console.warn(
            "[fish-cue-tagger] chunk fail-open:",
            err instanceof Error ? err.message : err
          );
          return chunk;
        }
      }
    );

    const stitched = spliceTaggedChunks(source, ranges, taggedChunks);
    const out = sanitizeFishS2TaggedText(source, stitched);
    console.log(
      `[fish-cue-tagger] model=${model} chars=${source.length} chunks=${chunks.length} parallel=${CUE_TAGGER_PARALLEL} ${Date.now() - started}ms failOpenChunks=${failOpenChunks}`
    );
    return out;
  } catch (err) {
    console.warn(
      "[fish-cue-tagger] fail-open:",
      err instanceof Error ? err.message : err
    );
    return source;
  }
}
