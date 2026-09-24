/**
 * One short DeepSeek call before a whole book is frozen.
 *
 * It sees the file title and the front of the text, not a guess about which
 * published book this is. It names lines to leave unspoken (copyright, ISBN,
 * permissions) and headings that should be spoken on their own. A short
 * foreword stays. The prose is not rewritten. A miss or a timeout leaves the
 * text on the existing cleanup path.
 */

import { getOpenRouterApiKey } from "@/lib/tts/providers/openrouter";

export const LISTEN_PREP_FRONT_CHARS = 7_000;
export const LISTEN_PREP_TIMEOUT_MS = 8_000;
export const LISTEN_PREP_MAX_TOKENS = 400;
export const DEFAULT_LISTEN_PREP_MODEL = "deepseek/deepseek-v4.1-flash";

const OPENROUTER_CHAT_URL =
  (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(
    /\/+$/,
    ""
  ) + "/chat/completions";

const LISTEN_PREP_PROVIDER = {
  only: ["deepseek"],
  allow_fallbacks: false,
} as const;

export type ListenPrepPlan = {
  drop: string[];
  headings: string[];
};

export type ListenPrepFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export function listenPrepSystemPrompt(): string {
  return [
    "You prepare text to be read aloud. You are given the file title and the front of that file.",
    "Do not identify or look up a published book. Do not rewrite sentences. Do not add words.",
    "Answer immediately. No reasoning. One JSON object only, no markdown.",
    '{"drop":string[],"headings":string[]}',
    "drop: exact phrases copied from the front that should not be spoken. Copyright lines, ISBN, cataloging-in-publication, permissions, and all-rights-reserved lines belong here.",
    "Keep a short foreword, preface, prologue, and introduction. Do not put those in drop.",
    "headings: exact heading lines from the front that should be spoken alone, such as Introduction or A Note on the Text, when they currently sit on the same line as the paragraph under them.",
    "If nothing should change, return empty arrays.",
  ].join(" ");
}

/** Front of the file, cut at the first chapter heading when that arrives early. */
export function listenPrepFront(raw: string, maxChars = LISTEN_PREP_FRONT_CHARS): string {
  const text = (raw || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const chapterAt = text.search(/\n(?:Chapter|CHAPTER|Part|PART)\s+\S/);
  let end = Math.min(text.length, maxChars);
  if (chapterAt > 80 && chapterAt < end) {
    const lineEnd = text.indexOf("\n", chapterAt + 1);
    end = lineEnd === -1 ? Math.min(text.length, maxChars) : Math.min(lineEnd, maxChars);
    return text.slice(0, end).trim();
  }
  if (end >= text.length) return text;
  const slice = text.slice(0, end);
  const breakAt = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf(". "));
  return (breakAt > 400 ? slice.slice(0, breakAt + 1) : slice).trim();
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
  return typeof content === "string" ? content : "";
}

export function coerceListenPrepPlan(value: unknown, front: string): ListenPrepPlan {
  const empty = { drop: [], headings: [] };
  if (!value || typeof value !== "object") return empty;
  const row = value as { drop?: unknown; headings?: unknown };
  const frontFold = front.toLowerCase();
  const phrases = (raw: unknown, min: number, max: number): string[] => {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const item of raw) {
      if (typeof item !== "string") continue;
      const phrase = item.replace(/\s+/g, " ").trim();
      if (phrase.length < min || phrase.length > max) continue;
      if (!frontFold.includes(phrase.toLowerCase())) continue;
      if (out.some((kept) => kept.toLowerCase() === phrase.toLowerCase())) continue;
      out.push(phrase);
      if (out.length >= 16) break;
    }
    return out;
  };
  return {
    drop: phrases(row.drop, 8, 180),
    headings: phrases(row.headings, 3, 80),
  };
}

function paragraphBlocks(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split(/\n\s*\n/)
    .map((block) => block.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function isChapterStart(paragraph: string): boolean {
  return /^(?:chapter|part)\b/i.test(paragraph.trim());
}

/**
 * Drop unspoken front-matter lines and lift named headings onto their own
 * paragraph. Body text after the first chapter is left alone.
 */
export function applyListenPrep(raw: string, plan: ListenPrepPlan): string {
  const blocks = paragraphBlocks(raw);
  if (blocks.length === 0) return "";
  const chapterAt = blocks.findIndex(isChapterStart);
  const limit = chapterAt === -1 ? blocks.length : chapterAt;
  const drops = plan.drop.map((phrase) => phrase.toLowerCase());
  const headings = plan.headings.map((heading) => heading.toLowerCase());
  const out: string[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (i < limit) {
      const folded = block.toLowerCase();
      const drop = drops.some(
        (phrase) => block.length <= 500 && folded.includes(phrase)
      );
      if (drop) continue;
      const heading = headings.find(
        (phrase) => folded === phrase || folded.startsWith(`${phrase} `)
      );
      if (heading && folded !== heading) {
        const title = block.slice(0, heading.length).trim();
        const rest = block.slice(heading.length).trim();
        if (title) out.push(title);
        if (rest) out.push(rest);
        continue;
      }
    }
    out.push(block);
  }
  return out.join("\n\n");
}

export async function planListenPrep(opts: {
  rawText: string;
  title?: string | null;
  fetch?: ListenPrepFetch;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}): Promise<ListenPrepPlan | null> {
  const front = listenPrepFront(opts.rawText || "");
  if (front.length < 40) return null;
  const apiKey = opts.apiKey ?? getOpenRouterApiKey();
  if (!apiKey) return null;
  const title = (opts.title || "").replace(/\s+/g, " ").trim();
  const user = title ? `Title: ${title}\n\n${front}` : front;
  const fetchFn = opts.fetch ?? fetch;
  try {
    const res = await fetchFn(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer":
          process.env.NEXT_PUBLIC_APP_URL || "https://echomancer.xyz",
        "X-Title": "Echomancer listen prep",
      },
      body: JSON.stringify({
        model: opts.model || DEFAULT_LISTEN_PREP_MODEL,
        temperature: 0,
        max_tokens: LISTEN_PREP_MAX_TOKENS,
        reasoning: { effort: "none" },
        provider: LISTEN_PREP_PROVIDER,
        messages: [
          { role: "system", content: listenPrepSystemPrompt() },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? LISTEN_PREP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    return coerceListenPrepPlan(unwrapJson(messageContent(data)), front);
  } catch {
    return null;
  }
}

/** Fail-open. The returned string is what `toSpeakableText` should see. */
export async function prepareForListening(
  rawText: string,
  opts?: {
    title?: string | null;
    fetch?: ListenPrepFetch;
    apiKey?: string;
  }
): Promise<string> {
  const plan = await planListenPrep({
    rawText,
    title: opts?.title,
    fetch: opts?.fetch,
    apiKey: opts?.apiKey,
  });
  if (!plan || (plan.drop.length === 0 && plan.headings.length === 0)) {
    return rawText;
  }
  const next = applyListenPrep(rawText, plan);
  return next.trim() ? next : rawText;
}
