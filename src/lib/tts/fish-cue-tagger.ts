/**
 * Cheap OpenRouter LLM tagger for Whole-book Fish / clone sections.
 *
 * Inserts official Fish S2 square-bracket cues only. Never rewrites prose.
 * Fail-open: missing key, timeout, or a rewrite → original section text.
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

const OPENROUTER_CHAT_URL = (
  process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1"
).replace(/\/+$/, "") + "/chat/completions";

const MIN_CHARS = 40;
const DEFAULT_TIMEOUT_MS = 12_000;

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

function taggerTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.FISH_CUE_TAGGER_TIMEOUT_MS);
  if (Number.isFinite(n) && n >= 1_000 && n <= 60_000) return n;
  return DEFAULT_TIMEOUT_MS;
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

export function fishCueTaggerSystemPrompt(): string {
  return [
    "You insert Fish Audio S2 square-bracket cues into audiobook narration.",
    "Do not rewrite, paraphrase, reorder, add, or delete any words or punctuation.",
    "Keep every existing [break] and [long-break].",
    "Insert only these tags (exact spelling): " + allowedCuePromptList() + ".",
    "You may prefix a listed emotion with slightly, very, or extremely (example: [slightly sad]).",
    "Prefer a cue at the start of a sentence. Sparse: at most one emotion per sentence, few per passage.",
    "Do not add celebrity impressions, explicit-content tags, or any tag not listed.",
    "Output only the tagged text. No markdown, no quotes, no explanation.",
  ].join(" ");
}

type ChatFetch = (
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

async function completeOpenRouterChat(opts: {
  text: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  fetchFn: ChatFetch;
}): Promise<string> {
  const maxTokens = Math.min(4_000, Math.max(256, opts.text.length + 400));
  const res = await opts.fetchFn(OPENROUTER_CHAT_URL, {
    method: "POST",
    headers: openRouterHeaders(opts.apiKey),
    body: JSON.stringify({
      model: opts.model,
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: fishCueTaggerSystemPrompt() },
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
 * Tag one speakable section (or packed chunk) that Fish will speak.
 * Never send the full book — callers pass `sections[i].text` only.
 */
export async function tagFishCuesForSection(
  sectionText: string,
  opts?: {
    fetch?: ChatFetch;
    model?: string;
    enabled?: boolean;
  }
): Promise<string> {
  const source = sectionText ?? "";
  if (!source.trim() || source.trim().length < MIN_CHARS) return source;
  const enabled =
    opts?.enabled ?? isFishCueTaggerEnabled();
  if (!enabled) return source;

  const apiKey = getOpenRouterApiKey();
  if (!apiKey) return source;

  const fetchFn = opts?.fetch ?? fetch;
  const model = opts?.model || fishCueTaggerModel();
  try {
    const raw = await completeOpenRouterChat({
      text: source,
      model,
      apiKey,
      timeoutMs: taggerTimeoutMs(),
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
