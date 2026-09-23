/**
 * One short DeepSeek call to suggest a stock narrator for an upload.
 *
 * The model sees the file title and the opening only (about a page), not the
 * book. Articles, biography, and general nonfiction are Andrew on standard
 * delivery. History is Randolph on standard delivery. A novel may be any
 * stock voice, standard or expressive, depending on the kind DeepSeek names.
 * Clones are never suggested. The picker can ignore the suggestion.
 */

import { getOpenRouterApiKey } from "@/lib/tts/providers/openrouter";
import {
  downloadFile,
  readStoragePrefix,
  uploadFile,
} from "@/lib/storage";
import {
  coerceNarratorRecommendation,
  type NarratorRecommendation,
} from "@/lib/tts/narrator-suggestion";

export {
  coerceNarratorRecommendation,
  narratorSuggestionLine,
  type NarratorCatalogVoiceId,
  type NarratorKind,
  type NarratorRecommendation,
} from "@/lib/tts/narrator-suggestion";

export const NARRATOR_EXCERPT_CHARS = 1_800;
/** Bytes to pull from storage. Comfortably covers the excerpt in UTF-8. */
export const NARRATOR_EXCERPT_BYTES = 6_000;
export const NARRATOR_JSON_NAME = "narrator.json";
export const DEFAULT_NARRATOR_MODEL = "deepseek/deepseek-v4.1-flash";
export const NARRATOR_TIMEOUT_MS = 8_000;

const OPENROUTER_CHAT_URL =
  (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(
    /\/+$/,
    ""
  ) + "/chat/completions";

const NARRATOR_PROVIDER = {
  only: ["deepseek"],
  allow_fallbacks: false,
} as const;

export type NarratorFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export function narratorObjectKey(uploadId: string): string {
  return `pdfs/${uploadId}/${NARRATOR_JSON_NAME}`;
}

export function contentObjectKey(uploadId: string): string {
  return `pdfs/${uploadId}/content.txt`;
}

/** Opening only. The rest of the book is not sent. */
export function openingExcerpt(
  text: string,
  maxChars = NARRATOR_EXCERPT_CHARS
): string {
  const normalized = (text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (normalized.length <= maxChars) return normalized;
  const slice = normalized.slice(0, maxChars);
  const breakAt = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(". "));
  const cut = breakAt > 400 ? slice.slice(0, breakAt + 1) : slice;
  return cut.trim();
}

export function narratorSystemPrompt(): string {
  return [
    "You suggest one stock narrator for a document.",
    "You are given the file title and the opening only. Do not ask for more text.",
    "Answer as soon as you can. Do not reason out loud.",
    "Reply with one JSON object and nothing else. No markdown.",
    'Shape: {"kind":"article"|"biography"|"history"|"nonfiction"|"novel","novelKind":string|null,"catalogVoiceId":"standard"|"michelle"|"clara"|"randolph","delivery":"standard"|"expressive"}',
    "kind article, biography, or nonfiction: catalogVoiceId must be standard and delivery must be standard. That voice is Andrew.",
    "kind history means nonfiction history: catalogVoiceId must be randolph and delivery must be standard.",
    "kind novel: set novelKind to a short name for the kind of novel, such as literary, mystery, romance, thriller, horror, fantasy, or historical.",
    "For a novel, pick the voice that fits that kind. standard is Andrew, a clear American male: literary, mystery, and quiet fiction on delivery standard; thriller, action, and dialogue-heavy fiction on delivery expressive.",
    "michelle is Michelle, a warm American female: romance, cozy, and contemporary. Use delivery expressive when the emotion should be performed, otherwise standard.",
    "clara is Clara, a US female narrator with no expressive delivery. delivery must be standard. Use her only when a female literary voice fits better than Michelle.",
    "randolph is Randolph, a British male: historical fiction and gothic. delivery standard for measured period prose, expressive for gothic or highly dramatic fiction.",
    "Never suggest a cloned voice. Never invent a catalogVoiceId.",
  ].join(" ");
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
  const content = message?.content;
  if (typeof content === "string") return content;
  return "";
}

export async function recommendNarrator(opts: {
  excerpt: string;
  fileName?: string | null;
  fetch?: NarratorFetch;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}): Promise<NarratorRecommendation | null> {
  const excerpt = openingExcerpt(opts.excerpt || "");
  if (excerpt.length < 40) return null;
  const apiKey = opts.apiKey ?? getOpenRouterApiKey();
  if (!apiKey) return null;
  const title = (opts.fileName || "")
    .replace(/\.[a-z0-9]{1,8}$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const user = title ? `Title: ${title}\n\n${excerpt}` : excerpt;
  const fetchFn = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? NARRATOR_TIMEOUT_MS;
  try {
    const res = await fetchFn(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer":
          process.env.NEXT_PUBLIC_APP_URL || "https://echomancer.xyz",
        "X-Title": "Echomancer narrator suggestion",
      },
      body: JSON.stringify({
        model: opts.model || DEFAULT_NARRATOR_MODEL,
        temperature: 0,
        max_tokens: 180,
        reasoning: { effort: "none" },
        provider: NARRATOR_PROVIDER,
        messages: [
          { role: "system", content: narratorSystemPrompt() },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    return coerceNarratorRecommendation(unwrapJson(messageContent(data)));
  } catch {
    return null;
  }
}

export function parseNarratorRecommendation(
  raw: string
): NarratorRecommendation | null {
  try {
    return coerceNarratorRecommendation(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function readCachedNarrator(
  uploadId: string
): Promise<NarratorRecommendation | null> {
  try {
    const buf = await downloadFile(narratorObjectKey(uploadId));
    return parseNarratorRecommendation(buf.toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Cached suggestion, or one DeepSeek call on the opening.
 * A missing key or a bad reply returns null and does not block the picker.
 */
export async function loadNarratorRecommendation(
  uploadId: string,
  fileName?: string | null,
  opts?: { fetch?: NarratorFetch }
): Promise<NarratorRecommendation | null> {
  const cached = await readCachedNarrator(uploadId);
  if (cached) return cached;
  let prefix = "";
  try {
    const buf = await readStoragePrefix(
      contentObjectKey(uploadId),
      NARRATOR_EXCERPT_BYTES
    );
    prefix = buf.toString("utf8").replace(/\uFFFD+$/u, "");
  } catch {
    return null;
  }
  const narrator = await recommendNarrator({
    excerpt: prefix,
    fileName,
    fetch: opts?.fetch,
  });
  if (!narrator) return null;
  try {
    await uploadFile(
      `pdfs/${uploadId}`,
      NARRATOR_JSON_NAME,
      Buffer.from(JSON.stringify(narrator), "utf8"),
      "application/json"
    );
  } catch (err) {
    console.warn(
      "[narrator] cache write failed:",
      err instanceof Error ? err.message : err
    );
  }
  return narrator;
}
