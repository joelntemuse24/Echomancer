/**
 * Cheap OpenRouter LLM tagger for Whole-book Fish / clone speakable text.
 *
 * One call tags the **full** frozen speakable with official Fish S2
 * square-bracket cues. The existing section packer then splits. Never
 * rewrites prose. Fail-open: missing key, timeout, or a rewrite → original.
 * Live Listen / Edge / Google never call this.
 */

import { getOpenRouterApiKey } from "@/lib/tts/providers/openrouter";
import {
  FISH_S2_EFFECT_CUES,
  FISH_S2_EMOTION_CUES,
  FISH_S2_TONE_CUES,
  sanitizeFishS2TaggedText,
} from "@/lib/tts/fish-s2-cues";

/** Near-free default. Override with FISH_CUE_TAGGER_MODEL (e.g. openrouter/free). */
export const DEFAULT_FISH_CUE_TAGGER_MODEL = "openai/gpt-oss-20b";

/** Max wait for the one-shot chat call. Return as soon as the model answers. */
export const DEFAULT_FISH_CUE_TAGGER_TIMEOUT_MS = 40_000;
export const MIN_FISH_CUE_TAGGER_TIMEOUT_MS = 1_000;
export const MAX_FISH_CUE_TAGGER_TIMEOUT_MS = 120_000;

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

function allowedCuePromptList(): string {
  return [
    "[break]",
    "[long-break]",
    ...FISH_S2_EMOTION_CUES.map((c) => `[${c}]`),
    ...FISH_S2_TONE_CUES.map((c) => `[${c}]`),
    ...FISH_S2_EFFECT_CUES.map((c) => `[${c}]`),
  ].join(", ");
}

export function fishCueTaggerSystemPrompt(
  timeoutMs: number = DEFAULT_FISH_CUE_TAGGER_TIMEOUT_MS
): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  return [
    "You insert Fish Audio S2 square-bracket cues into audiobook narration.",
    `You have up to about ${seconds} seconds, but answer as soon as you can.`,
    "Do not rewrite, paraphrase, reorder, add, or delete any words or punctuation.",
    "Keep every existing [break] and [long-break].",
    "Insert only these tags (exact spelling, allowlist only): " +
      allowedCuePromptList() +
      ".",
    "You may prefix a listed emotion with slightly, very, or extremely (example: [slightly sad]).",
    "Prefer a cue at the start of a sentence. Sparse: at most one emotion per sentence, few per passage.",
    "Do not add celebrity impressions, explicit-content tags, or any tag not listed.",
    "Output only the tagged text. No markdown, no quotes, no explanation.",
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

function maxOutputTokens(text: string): number {
  // Output is the same prose plus sparse tags. ~3–4 chars/token.
  const estimated = Math.ceil(text.length / 3) + 1024;
  return Math.min(128_000, Math.max(1024, estimated));
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
      max_tokens: maxOutputTokens(opts.text),
      messages: [
        {
          role: "system",
          content: fishCueTaggerSystemPrompt(opts.timeoutMs),
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
 * Tag the full frozen speakable in **one** OpenRouter chat call.
 * Callers then run the existing section packer on the result.
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
  try {
    const raw = await completeOpenRouterChat({
      text: source,
      model,
      apiKey,
      timeoutMs,
      fetchFn,
    });
    if (!raw) return source;
    return sanitizeFishS2TaggedText(source, raw);
  } catch (err) {
    console.warn(
      "[fish-cue-tagger] fail-open:",
      err instanceof Error ? err.message : err
    );
    return source;
  }
}
