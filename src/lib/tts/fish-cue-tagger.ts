/**
 * Cheap OpenRouter LLM tagger for Whole-book speakable text (Fish, Edge, Google).
 *
 * One logical pass inserts allowlisted Fish S2 square-bracket cues. The model
 * infers the passage's text type and picks denser attitude and delivery tags
 * from that list. Invented brackets are stripped. There is no book-level
 * seminar prefix.
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
import {
  FISH_S2_EFFECT_CUES,
  FISH_S2_EMOTION_CUES,
  FISH_S2_TONE_CUES,
  restrainBreathFishCues,
  restrainHotFishCues,
  sanitizeFishS2TaggedText,
} from "@/lib/tts/fish-s2-cues";

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

/** Every Fish-accepted cue, by category. Nothing outside this list is valid. */
export function fishCueTaggerCheatSheet(): string {
  return [
    `Emotions: ${FISH_S2_EMOTION_CUES.join(", ")}.`,
    `Tones: ${FISH_S2_TONE_CUES.join(", ")}.`,
    `Effects: ${FISH_S2_EFFECT_CUES.join(", ")}.`,
    "Pauses: break, long-break.",
  ].join(" ");
}

export function fishCueTaggerSystemPrompt(): string {
  return [
    "You insert Fish Audio S2 square-bracket performance cues into narration.",
    "Answer as soon as you can. Do not reason out loud.",
    "Do not rewrite, paraphrase, reorder, add, or delete any words or punctuation.",
    "Keep every existing [break] and [long-break].",
    "Allowlist only. Exact spelling. Use only the cues named below. Do not invent brackets.",
    fishCueTaggerCheatSheet(),
    "You may prefix a listed emotion with slightly, very, or extremely (example: [slightly sad]). Intensity applies to emotions only, not tones or effects.",
    "First infer what kind of text this passage is — academic lecture, nonfiction essay, dialogue-heavy fiction, memoir, technical manual, polemic, satire, or another kind — and choose allowlisted cues that fit that kind.",
    "Do not print the text type, a genre label, or an explanation, as words or as its own bracket.",
    "Adapt line by line from the allowlist. Narrative nonfiction and audiobook prose prefer [confident] and [emphasis]. Do not use [calm] as the default register for exposition, description, headings, or a lecture. [calm] makes this voice breathe. Use [calm] only when that sentence is soothing, peaceful, or the speaker is calm, and do not stack [calm] with another cue. Do not use [soft tone] for narration, description, headings, or exposition. [soft tone] is a lullaby cue and makes the voice breathe. Fiction can use the emotion the line earns, kept close to the voice. A polemic or satire can use [sarcastic], [disdainful], or [contemptuous]. A manual or flat report can use [confident], [indifferent], or [resigned] for matter-of-fact delivery.",
    "Do not use [shouting], [screaming], [hysterical], or [extremely excited] on narration, description, or exposition. Those cues are only for dialogue that clearly shouts, screams, or is hysterical (the speaker shouted, screamed, yelled, or is in hysterics). Otherwise map heat down to [confident] or [emphasis].",
    "Do not replace those line cues with one book-level prefix.",
    "Map attitudes onto the allowlist. Aggression is [angry]. Do not reach for [extremely angry] on audiobook prose. Cynicism is [sarcastic], [disdainful], or [contemptuous]. Sarcasm is [sarcastic]. Matter-of-fact delivery is [confident], [indifferent], or [resigned]. Whisper is [whispering] only when that sentence says whispered or in a whisper. Do not use [whispering] because a line says softly. Stress a word with [emphasis]. Curiosity is [curious].",
    "Expressive and dialogue lines should carry allowlisted cues. A sentence may take several cues from the list when it holds more than one attitude, for example [confident][emphasis] on narration, or [angry][shouting] when dialogue clearly shouts. Do not put [shouting] or [screaming] on calm exposition. Do not put [soft tone] or a default [calm] on ordinary narration.",
    "Use an effect such as laughing, sobbing, sighing, gasping, panting, or groaning only when the same sentence depicts that sound. Do not add sighing, gasping, panting, groaning, yawning, or whispering to steady narration.",
    "Keep [break] and [long-break]. They are silence, not breaths.",
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
 * Output is the same prose plus allowlisted cues. Leave headroom so a dense
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
    const out = restrainBreathFishCues(
      restrainHotFishCues(
        sanitizeFishS2TaggedText(source, stitched),
        "narration"
      )
    );
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
