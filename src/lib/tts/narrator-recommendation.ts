/**
 * One short DeepSeek call to suggest a stock narrator for an upload.
 *
 * The model sees the file title and the cleaned whole book. Articles, biography,
 * and general nonfiction are Andrew on standard
 * delivery. History is Randolph on standard delivery. A novel may be any
 * stock voice, standard or expressive, depending on the kind DeepSeek names.
 * Clones are never suggested. The picker can ignore the suggestion.
 */

import { getOpenRouterApiKey } from "@/lib/tts/providers/openrouter";
import { downloadFile, uploadFile } from "@/lib/storage";
import {
  readListenPrepCache,
  scheduleListenPrepUnlessFresh,
} from "@/lib/tts/listen-prep-cache";
import {
  coerceNarratorRecommendation,
  type NarratorRecommendation,
} from "@/lib/tts/narrator-suggestion";

export {
  coerceNarratorRecommendation,
  narratorMarksVoice,
  withNarratorRecommendation,
  type NarratorCatalogVoiceId,
  type NarratorKind,
  type NarratorRecommendation,
} from "@/lib/tts/narrator-suggestion";

export const NARRATOR_JSON_NAME = "narrator.json";
export const DEFAULT_NARRATOR_MODEL = "deepseek/deepseek-v4.1-flash";
/** The suggestion follows a whole-book cleanup, so this wait covers that reply. */
export const NARRATOR_TIMEOUT_MS = 20_000;
export const NARRATOR_MAX_TOKENS = 64;

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

export function narratorSystemPrompt(): string {
  return [
    "The user message is the cleaned whole book and its file title. Do not identify or look up a published book. Pick one stock narrator.",
    "Answer immediately. No reasoning. One JSON object only, no markdown.",
    '{"kind":"article"|"biography"|"history"|"nonfiction"|"novel","novelKind":string|null,"catalogVoiceId":"standard"|"michelle"|"clara"|"randolph","delivery":"standard"|"expressive"}',
    "Voices: standard is Andrew, clear American male. michelle is Michelle, warm American female. clara is Clara, US female, delivery standard only. randolph is Randolph, British male.",
    "article, biography, or nonfiction: catalogVoiceId must be standard and delivery must be standard.",
    "history (nonfiction history): catalogVoiceId must be randolph and delivery must be standard.",
    "novel: set novelKind (literary, mystery, romance, thriller, horror, fantasy, historical).",
    "Novel voices: Andrew for literary, mystery, and quiet fiction (standard), and for thriller or dialogue-heavy fiction (expressive). Michelle for romance, cozy, and contemporary (expressive when the feeling should be performed). Clara when a female literary voice fits better than Michelle. Randolph for historical fiction and gothic (expressive only when it is gothic or highly dramatic).",
    "Never a cloned voice.",
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
  const excerpt = opts.excerpt || "";
  if (excerpt.trim().length < 40) return null;
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
        max_tokens: NARRATOR_MAX_TOKENS,
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
 * Cached suggestion from the listen-prep notes. Does not send the book
 * again, and does not start a second cleanup when one is already stored.
 * A miss schedules cleanup and returns null so the picker can show now.
 */
export async function loadNarratorRecommendation(
  uploadId: string,
  fileName?: string | null,
  opts?: { fetch?: NarratorFetch }
): Promise<NarratorRecommendation | null> {
  void fileName;
  void opts;
  const cached = await readCachedNarrator(uploadId);
  if (cached) return cached;
  let book = "";
  try {
    book = (await downloadFile(contentObjectKey(uploadId))).toString("utf8");
  } catch {
    return null;
  }
  const prep = await readListenPrepCache(uploadId, book);
  if (!prep) {
    await scheduleListenPrepUnlessFresh(uploadId, book);
    return null;
  }
  if (!prep.narrator) return null;
  try {
    await uploadFile(
      `pdfs/${uploadId}`,
      NARRATOR_JSON_NAME,
      Buffer.from(JSON.stringify(prep.narrator), "utf8"),
      "application/json"
    );
  } catch (err) {
    console.warn(
      "[narrator] cache write failed:",
      err instanceof Error ? err.message : err
    );
  }
  return prep.narrator;
}
