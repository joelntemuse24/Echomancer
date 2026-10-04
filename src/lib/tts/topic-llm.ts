/**
 * Optional placement of printed-contents topics.
 *
 * Off unless `CHAPTER_TOPIC_LLM=1`. The sync path stays verbatim. The model
 * may only name paragraph numbers that exist in the chunk, topics stay in
 * order, and "none" is allowed. Verbatim title matches are anchors. A
 * timeout, a bad reply, or a missing key leaves the verbatim tree.
 */

import type { BookChapter, ChapterHint, ChaptersDocument } from "@/lib/book-chapters";
import { parsePrintedContents, placeTopicPhrase } from "@/lib/printed-toc";
import {
  listenPrepFallbackModel,
  listenPrepModel,
  listenPrepProvider,
} from "@/lib/tts/listen-prep";
import { getOpenRouterApiKey } from "@/lib/tts/providers/openrouter";

const CHAT_URL =
  (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "") +
  "/chat/completions";

export const TOPIC_CALL_TIMEOUT_MS = 15_000;
export const TOPIC_TOTAL_BUDGET_MS = 90_000;
const CHUNK_PARAGRAPHS = 20;
const CHUNK_CHARS = 6_000;

export function topicLlmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CHAPTER_TOPIC_LLM === "1";
}

export interface NumberedParagraph {
  number: number;
  text: string;
  charStart: number;
}

export interface TopicAnswer {
  topic: number;
  paragraph: number | "none";
}

export function numberedParagraphs(partText: string, base: number): NumberedParagraph[] {
  const text = partText.replace(/\r\n/g, "\n");
  const spans: { text: string; start: number }[] = [];
  const re = /\n\s*\n/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    spans.push({ text: text.slice(start, match.index), start });
    start = match.index + match[0].length;
  }
  spans.push({ text: text.slice(start), start });
  const out: NumberedParagraph[] = [];
  for (const span of spans) {
    const cleaned = span.text.replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    out.push({
      number: out.length + 1,
      text: cleaned,
      charStart: base + span.start,
    });
  }
  return out;
}

function keepMonotonic(anchors: Map<number, number>): Map<number, number> {
  let last = 0;
  const next = new Map<number, number>();
  for (const [topic, paragraph] of [...anchors.entries()].sort((a, b) => a[0] - b[0])) {
    if (paragraph <= last) continue;
    next.set(topic, paragraph);
    last = paragraph;
  }
  return next;
}

/** Paragraph number of a topic whose full title occurs in exactly one paragraph. */
export function verbatimAnchorParagraphs(
  paragraphs: NumberedParagraph[],
  topics: string[]
): Map<number, number> {
  const anchors = new Map<number, number>();
  for (let i = 0; i < topics.length; i++) {
    const hits: number[] = [];
    for (const paragraph of paragraphs) {
      if (placeTopicPhrase(paragraph.text, topics[i]!, 0) != null) hits.push(paragraph.number);
      if (hits.length > 1) break;
    }
    if (hits.length === 1) anchors.set(i, hits[0]!);
  }
  return keepMonotonic(anchors);
}

/**
 * Keep in-range, strictly increasing paragraph numbers. Anchors stay even
 * when the model names a different paragraph. Out-of-range and backwards
 * answers are dropped.
 */
export function acceptTopicPlacements(
  topicCount: number,
  paragraphCount: number,
  answers: TopicAnswer[],
  anchors: Map<number, number>
): Map<number, number> {
  const byTopic = new Map<number, number[]>();
  for (const answer of answers) {
    if (!Number.isInteger(answer.topic) || answer.topic < 0 || answer.topic >= topicCount) {
      continue;
    }
    if (answer.paragraph === "none" || !Number.isInteger(answer.paragraph)) continue;
    const list = byTopic.get(answer.topic) ?? [];
    list.push(answer.paragraph);
    byTopic.set(answer.topic, list);
  }
  const anchorAt = [...anchors.entries()].sort((a, b) => a[0] - b[0]);
  const nextAnchorAfter = (topic: number): number | null => {
    for (const [index, paragraph] of anchorAt) {
      if (index > topic) return paragraph;
    }
    return null;
  };
  const placed = new Map<number, number>();
  let last = 0;
  for (let topic = 0; topic < topicCount; topic++) {
    const anchored = anchors.get(topic);
    if (anchored != null) {
      if (anchored >= 1 && anchored <= paragraphCount && anchored > last) {
        placed.set(topic, anchored);
        last = anchored;
      }
      continue;
    }
    const next = nextAnchorAfter(topic);
    for (const answer of byTopic.get(topic) ?? []) {
      if (answer < 1 || answer > paragraphCount || answer <= last) continue;
      if (next != null && answer >= next) continue;
      placed.set(topic, answer);
      last = answer;
      break;
    }
  }
  return placed;
}

export function paragraphChunks(paragraphs: NumberedParagraph[]): NumberedParagraph[][] {
  const chunks: NumberedParagraph[][] = [];
  let current: NumberedParagraph[] = [];
  let chars = 0;
  for (const paragraph of paragraphs) {
    if (
      current.length > 0 &&
      (current.length >= CHUNK_PARAGRAPHS || chars + paragraph.text.length > CHUNK_CHARS)
    ) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(paragraph);
    chars += paragraph.text.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function parsePlacements(content: string): TopicAnswer[] | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(content.slice(start, end + 1)) as { placements?: unknown };
    if (!Array.isArray(parsed.placements)) return null;
    const out: TopicAnswer[] = [];
    for (const row of parsed.placements) {
      if (!row || typeof row !== "object") continue;
      const topic = (row as { topic?: unknown }).topic;
      const paragraph = (row as { paragraph?: unknown }).paragraph;
      if (typeof topic !== "number" || !Number.isInteger(topic)) continue;
      if (paragraph === "none") {
        out.push({ topic, paragraph: "none" });
        continue;
      }
      if (typeof paragraph === "number" && Number.isInteger(paragraph)) {
        out.push({ topic, paragraph });
      }
    }
    return out;
  } catch {
    return null;
  }
}

async function complete(
  apiKey: string,
  model: string,
  route: "primary" | "fallback",
  prompt: string,
  fetchFn: typeof fetch,
  signal: AbortSignal
): Promise<string | null> {
  const response = await fetchFn(CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    signal,
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      provider: listenPrepProvider(model, route),
      response_format: { type: "json_object" },
    }),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return body.choices?.[0]?.message?.content ?? null;
}

function chunkPrompt(
  topics: string[],
  chunk: NumberedParagraph[],
  anchors: Map<number, number>,
  open: number[]
): string {
  const numbers = new Set(chunk.map((paragraph) => paragraph.number));
  const anchorLines = [...anchors.entries()]
    .filter(([, paragraph]) => numbers.has(paragraph))
    .map(([topic, paragraph]) => `topic ${topic} "${topics[topic]}" is paragraph ${paragraph}`);
  return [
    "Each topic starts at one numbered paragraph in this chunk, or none.",
    'Topics stay in order. Reply JSON {"placements":[{"topic":0,"paragraph":3},{"topic":1,"paragraph":"none"}]}.',
    "Use only paragraph numbers shown below. Do not move an anchor.",
    anchorLines.length ? `Anchors: ${anchorLines.join("; ")}` : "",
    "Topics:",
    open.map((topic) => `${topic}. ${topics[topic]}`).join("\n"),
    "Paragraphs:",
    chunk.map((paragraph) => `${paragraph.number}. ${paragraph.text.slice(0, 500)}`).join("\n"),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Ask which paragraph each topic starts at. Returns null on timeout, a bad
 * reply, or an aborted budget. Anchors are included in a successful map.
 */
export async function placePartTopics(
  topics: string[],
  paragraphs: NumberedParagraph[],
  opts: {
    fetch: typeof fetch;
    apiKey: string;
    signal: AbortSignal;
    callTimeoutMs?: number;
    locked?: Map<number, number>;
  }
): Promise<Map<number, number> | null> {
  const anchors = verbatimAnchorParagraphs(paragraphs, topics);
  if (opts.locked) {
    for (const [topic, paragraph] of opts.locked) {
      if (!anchors.has(topic) && paragraph >= 1 && paragraph <= paragraphs.length) {
        anchors.set(topic, paragraph);
      }
    }
  }
  const fixed = keepMonotonic(anchors);
  if (topics.length === 0 || paragraphs.length === 0) return fixed;
  const openTopics = topics.map((_, topic) => topic).filter((topic) => !fixed.has(topic));
  if (openTopics.length === 0) return fixed;
  const answers: TopicAnswer[] = [];
  const callTimeout = opts.callTimeoutMs ?? TOPIC_CALL_TIMEOUT_MS;
  for (const chunk of paragraphChunks(paragraphs)) {
    if (opts.signal.aborted) return null;
    const numbers = new Set(chunk.map((paragraph) => paragraph.number));
    const fixedList = [...fixed.entries()].sort((a, b) => a[0] - b[0]);
    const open = openTopics.filter((topic) => {
      const previous = [...fixedList].reverse().find(([index]) => index < topic);
      const next = fixedList.find(([index]) => index > topic);
      const lo = previous ? previous[1] + 1 : 1;
      const hi = next ? next[1] - 1 : paragraphs.length;
      return [...numbers].some((number) => number >= lo && number <= hi);
    });
    if (open.length === 0) continue;
    const prompt = chunkPrompt(topics, chunk, fixed, open);
    const once = async (model: string, route: "primary" | "fallback") => {
      const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(callTimeout)]);
      return complete(opts.apiKey, model, route, prompt, opts.fetch, signal);
    };
    try {
      const primary = await once(listenPrepModel(), "primary");
      const parsed = primary ? parsePlacements(primary) : null;
      if (parsed) {
        answers.push(...parsed);
        continue;
      }
      const fallback = await once(listenPrepFallbackModel(), "fallback");
      const parsedFallback = fallback ? parsePlacements(fallback) : null;
      if (!parsedFallback) return null;
      answers.push(...parsedFallback);
    } catch {
      return null;
    }
  }
  return acceptTopicPlacements(topics.length, paragraphs.length, answers, fixed);
}

function tocEntries(spoken: string, hint: ChapterHint) {
  const fromLines = hint.tocLines?.length ? parsePrintedContents(hint.tocLines) : [];
  if (fromLines.length >= 2) return fromLines;
  const paras = spoken
    .split(/\n\s*\n/)
    .slice(0, 80)
    .map((line) => line.replace(/\s+/g, " ").trim());
  return parsePrintedContents(paras);
}

function paragraphNumberAt(paragraphs: NumberedParagraph[], charStart: number): number | null {
  for (let i = 0; i < paragraphs.length; i++) {
    const here = paragraphs[i]!.charStart;
    const next = paragraphs[i + 1]?.charStart ?? Number.POSITIVE_INFINITY;
    if (charStart >= here && charStart < next) return paragraphs[i]!.number;
  }
  return null;
}

/**
 * Rebuild printed-toc children from anchors plus validated model answers.
 * Returns null when the model cannot be used, so the caller keeps verbatim.
 */
export async function placePrintedTocTopics(
  spoken: string,
  doc: ChaptersDocument,
  hint: ChapterHint,
  opts?: { fetch?: typeof fetch; apiKey?: string; budgetMs?: number; callTimeoutMs?: number }
): Promise<ChaptersDocument | null> {
  const apiKey = opts?.apiKey ?? getOpenRouterApiKey();
  if (!apiKey || doc.source !== "printed-toc") return null;
  const entries = tocEntries(spoken, hint);
  if (entries.length < 2) return null;
  const fetchFn = opts?.fetch ?? fetch;
  const budget = AbortSignal.timeout(opts?.budgetMs ?? TOPIC_TOTAL_BUDGET_MS);
  const chapters: BookChapter[] = [];
  for (const chapter of doc.chapters) {
    const entry = entries.find((item) => item.label === chapter.title);
    if (!entry || entry.topics.length === 0) {
      chapters.push(chapter);
      continue;
    }
    const partEnd = chapter.charEnd;
    const paragraphs = numberedParagraphs(spoken.slice(chapter.charStart, partEnd), chapter.charStart);
    const locked = new Map<number, number>();
    for (const child of chapter.children ?? []) {
      const topic = entry.topics.findIndex((item) => item.title === child.title);
      if (topic < 0) continue;
      const number = paragraphNumberAt(paragraphs, child.charStart);
      if (number != null) locked.set(topic, number);
    }
    const placed = await placePartTopics(
      entry.topics.map((topic) => topic.title),
      paragraphs,
      {
        fetch: fetchFn,
        apiKey,
        signal: budget,
        callTimeoutMs: opts?.callTimeoutMs,
        locked,
      }
    );
    if (!placed) return null;
    const children: BookChapter[] = [];
    for (const [topicIndex, paragraphNumber] of [...placed.entries()].sort((a, b) => a[0] - b[0])) {
      const paragraph = paragraphs.find((item) => item.number === paragraphNumber);
      if (!paragraph) continue;
      if (paragraph.charStart < chapter.charStart || paragraph.charStart >= partEnd) continue;
      children.push({
        index: children.length,
        title: entry.topics[topicIndex]!.title.slice(0, 120),
        level: 2,
        charStart: paragraph.charStart,
        charEnd: partEnd,
      });
    }
    for (let c = 0; c < children.length; c++) {
      children[c]!.charEnd = children[c + 1]?.charStart ?? partEnd;
    }
    chapters.push(children.length > 0 ? { ...chapter, children } : { ...chapter, children: undefined });
  }
  return { ...doc, chapters };
}
