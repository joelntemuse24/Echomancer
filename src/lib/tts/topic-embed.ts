/**
 * Placement of printed-contents topics by embedding similarity.
 *
 * Off unless `CHAPTER_TOPIC_EMBED=1`. Topic titles (queries) and body
 * paragraphs (documents) go to a hosted OpenAI-compatible `/embeddings` API.
 * The default is OpenRouter `qwen/qwen3-embedding-8b` ($0.01 / 1M tokens) on
 * the existing `OPENROUTER_API_KEY`. `CHAPTER_EMBED_MODEL` swaps the model,
 * and `CHAPTER_EMBED_PROVIDER=deepinfra|cloudflare` reaches the hosted
 * `google/embeddinggemma-300m`. EmbeddingGemma 2 is not served by any host
 * yet; once one does, point `CHAPTER_EMBED_MODEL` at it (same prefixes).
 * Each topic without a verbatim anchor takes the most similar paragraph
 * between its neighbours, and a match under the similarity floor is dropped.
 * Topics stay in order. A missing key, a timeout, or a bad reply returns null
 * and the caller keeps the verbatim tree.
 */

import type { ChapterHint, ChaptersDocument } from "@/lib/book-chapters";
import { getOpenRouterApiKey } from "@/lib/tts/providers/openrouter";
import {
  keepMonotonic,
  rebuildPrintedTocTopics,
  verbatimAnchorParagraphs,
  type NumberedParagraph,
} from "@/lib/tts/topic-llm";

export const TOPIC_EMBED_CALL_TIMEOUT_MS = 20_000;
export const TOPIC_EMBED_TOTAL_BUDGET_MS = 90_000;
export const TOPIC_EMBED_BATCH = 32;
/**
 * Paragraph characters sent to the model. The start of a section carries its
 * topic. 1,000 characters keeps a whole book near 150K tokens and stays inside
 * the 2K-token context of the hosted EmbeddingGemma 300m.
 */
const PARAGRAPH_CHARS = 1_000;

/**
 * Default lowest cosine similarity that still counts as a placement. The
 * assigner takes the best paragraph in each window, so the floor only drops a
 * topic whose window has nothing close. Not yet calibrated on real books;
 * `CHAPTER_EMBED_MIN_SIMILARITY` overrides it after a spot-check.
 */
export const TOPIC_EMBED_MIN_SIMILARITY = 0.35;

export function embedMinSimilarity(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CHAPTER_EMBED_MIN_SIMILARITY?.trim();
  if (!raw) return TOPIC_EMBED_MIN_SIMILARITY;
  const value = Number(raw);
  return Number.isFinite(value) && value > -1 && value < 1 ? value : TOPIC_EMBED_MIN_SIMILARITY;
}

export interface EmbedPrefixes {
  query: string;
  document: string;
}

const QWEN3_QUERY_INSTRUCTION =
  "Instruct: Given a section title from a book's table of contents, retrieve the passage where that section begins\nQuery: ";

/**
 * Task prefixes by model family. Hosted APIs take raw text, so the client
 * adds them. EmbeddingGemma uses the model card's query / document strings
 * (SentenceTransformers' Retrieval-query / Retrieval-document). Qwen3-Embedding
 * wants an instruction on the query side only. Other models get none.
 * `CHAPTER_EMBED_QUERY_PREFIX` / `CHAPTER_EMBED_DOCUMENT_PREFIX` override.
 */
export function embedPrefixes(model: string, env: NodeJS.ProcessEnv = process.env): EmbedPrefixes {
  const lower = model.toLowerCase();
  let base: EmbedPrefixes = { query: "", document: "" };
  if (lower.includes("embeddinggemma")) {
    base = { query: "task: search result | query: ", document: "title: none | text: " };
  } else if (lower.includes("qwen3-embedding")) {
    base = { query: QWEN3_QUERY_INSTRUCTION, document: "" };
  }
  return {
    query: env.CHAPTER_EMBED_QUERY_PREFIX ?? base.query,
    document: env.CHAPTER_EMBED_DOCUMENT_PREFIX ?? base.document,
  };
}

export type EmbedProvider = "openrouter" | "deepinfra" | "cloudflare";

export const DEFAULT_EMBED_MODEL: Record<EmbedProvider, string> = {
  openrouter: "qwen/qwen3-embedding-8b",
  deepinfra: "google/embeddinggemma-300m",
  cloudflare: "@cf/google/embeddinggemma-300m",
};

export interface EmbedConfig {
  provider: EmbedProvider;
  url: string;
  apiKey: string;
  model: string;
  prefixes: EmbedPrefixes;
}

export function topicEmbedEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CHAPTER_TOPIC_EMBED === "1";
}

/**
 * Endpoint, key, and model from env. `CHAPTER_EMBED_PROVIDER` is `openrouter`
 * (default), `deepinfra`, or `cloudflare`. `CHAPTER_EMBED_API_KEY` wins, else
 * the provider's own key (`OPENROUTER_API_KEY`, `DEEPINFRA_API_KEY`, or
 * `CLOUDFLARE_AI_API_TOKEN` with `CLOUDFLARE_ACCOUNT_ID`).
 * `CHAPTER_EMBED_BASE_URL` points at any other OpenAI-compatible host.
 * Returns null when anything required is missing.
 */
export function embedConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EmbedConfig | null {
  const raw = (env.CHAPTER_EMBED_PROVIDER || "openrouter").trim().toLowerCase();
  if (raw !== "openrouter" && raw !== "deepinfra" && raw !== "cloudflare") return null;
  const provider: EmbedProvider = raw;
  const ownKey =
    provider === "openrouter"
      ? env === process.env
        ? getOpenRouterApiKey()
        : env.OPENROUTER_API_KEY || env.OPEN_ROUTER_API_KEY
      : provider === "deepinfra"
        ? env.DEEPINFRA_API_KEY
        : env.CLOUDFLARE_AI_API_TOKEN;
  const apiKey = (env.CHAPTER_EMBED_API_KEY || ownKey || "").trim();
  if (!apiKey) return null;
  let base = env.CHAPTER_EMBED_BASE_URL?.trim();
  if (!base) {
    if (provider === "openrouter") {
      base = env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1";
    } else if (provider === "deepinfra") {
      base = "https://api.deepinfra.com/v1/openai";
    } else {
      const account = env.CLOUDFLARE_ACCOUNT_ID?.trim();
      if (!account) return null;
      base = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1`;
    }
  }
  const model = env.CHAPTER_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL[provider];
  return {
    provider,
    url: base.replace(/\/+$/, "") + "/embeddings",
    apiKey,
    model,
    prefixes: embedPrefixes(model, env),
  };
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface EmbedOptions {
  fetch?: typeof fetch;
  /** Explicit config; `undefined` reads env, `null` means not configured. */
  config?: EmbedConfig | null;
  signal?: AbortSignal;
  callTimeoutMs?: number;
  batchSize?: number;
}

/** OpenAI `/embeddings` reply rows (`data[].embedding`), ordered by `index`. */
function validEmbeddings(value: unknown, count: number): number[][] | null {
  if (!Array.isArray(value) || value.length !== count) return null;
  const rows: number[][] = new Array(count);
  for (let i = 0; i < value.length; i++) {
    const item = value[i] as { index?: unknown; embedding?: unknown } | null;
    if (!item || typeof item !== "object") return null;
    const index = typeof item.index === "number" ? item.index : i;
    const vector = item.embedding;
    if (!Number.isInteger(index) || index < 0 || index >= count || rows[index]) return null;
    if (!Array.isArray(vector) || vector.length === 0) return null;
    if (!vector.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
    rows[index] = vector as number[];
  }
  return rows;
}

/**
 * Embed texts in batches with the model's query or document prefix. Returns
 * null on missing config, a non-2xx reply, a malformed body, a timeout, or an
 * aborted budget.
 */
export async function embedTexts(
  texts: string[],
  kind: "query" | "document",
  opts: EmbedOptions = {}
): Promise<number[][] | null> {
  const config = opts.config === undefined ? embedConfigFromEnv() : opts.config;
  if (!config) return null;
  if (texts.length === 0) return [];
  const fetchFn = opts.fetch ?? fetch;
  const batchSize = Math.max(1, opts.batchSize ?? TOPIC_EMBED_BATCH);
  const callTimeout = opts.callTimeoutMs ?? TOPIC_EMBED_CALL_TIMEOUT_MS;
  const prefix = config.prefixes[kind];
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    if (opts.signal?.aborted) return null;
    const batch = texts.slice(i, i + batchSize);
    const timeout = AbortSignal.timeout(callTimeout);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    try {
      const response = await fetchFn(config.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        signal,
        body: JSON.stringify({
          model: config.model,
          input: batch.map((text) => prefix + text),
          encoding_format: "float",
        }),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { data?: unknown };
      const rows = validEmbeddings(body.data, batch.length);
      if (!rows) return null;
      out.push(...rows);
    } catch {
      return null;
    }
  }
  return out;
}

/**
 * Similarity input: a topic × paragraph matrix (`scores[topic][paragraphIndex]`,
 * paragraph number minus one), or the raw vectors to compare.
 */
export type TopicScores =
  | number[][]
  | { topics: number[][]; paragraphs: number[][] };

function scoreAt(input: TopicScores, topic: number, paragraphIndex: number): number {
  if (Array.isArray(input)) return input[topic]?.[paragraphIndex] ?? Number.NEGATIVE_INFINITY;
  const query = input.topics[topic];
  const document = input.paragraphs[paragraphIndex];
  if (!query || !document) return Number.NEGATIVE_INFINITY;
  return cosineSimilarity(query, document);
}

/**
 * Keep anchors, then give each open topic in contents order the most similar
 * paragraph that sits after the previous placement and before the next
 * anchor. A best score under `minSimilarity` leaves the topic out. Ties take
 * the earlier paragraph. Returns paragraph numbers by topic index.
 */
export function assignTopicsByEmbedding(
  topics: string[],
  paragraphs: NumberedParagraph[],
  scoresOrEmbeddings: TopicScores,
  anchors: Map<number, number>,
  minSimilarity: number = embedMinSimilarity()
): Map<number, number> {
  const anchorAt = [...anchors.entries()].sort((a, b) => a[0] - b[0]);
  const nextAnchorAfter = (topic: number): number | null => {
    for (const [index, paragraph] of anchorAt) {
      if (index > topic) return paragraph;
    }
    return null;
  };
  const placed = new Map<number, number>();
  let last = 0;
  for (let topic = 0; topic < topics.length; topic++) {
    const anchored = anchors.get(topic);
    if (anchored != null) {
      if (anchored >= 1 && anchored <= paragraphs.length && anchored > last) {
        placed.set(topic, anchored);
        last = anchored;
      }
      continue;
    }
    const next = nextAnchorAfter(topic);
    const hi = next != null ? Math.min(next - 1, paragraphs.length) : paragraphs.length;
    let best = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let number = last + 1; number <= hi; number++) {
      const score = scoreAt(scoresOrEmbeddings, topic, number - 1);
      if (score > bestScore) {
        best = number;
        bestScore = score;
      }
    }
    if (best > 0 && bestScore >= minSimilarity) {
      placed.set(topic, best);
      last = best;
    }
  }
  return placed;
}

/**
 * Embed one part's open topics and paragraphs and assign by similarity.
 * Returns null when the embeddings API cannot be used. Anchors are included in a
 * successful map.
 */
export async function placePartTopicsByEmbed(
  topics: string[],
  paragraphs: NumberedParagraph[],
  opts: EmbedOptions & { locked?: Map<number, number> }
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
  const open = topics.map((_, topic) => topic).filter((topic) => !fixed.has(topic));
  if (open.length === 0) return fixed;
  const queries = await embedTexts(
    open.map((topic) => topics[topic]!),
    "query",
    opts
  );
  if (!queries) return null;
  const documents = await embedTexts(
    paragraphs.map((paragraph) => paragraph.text.slice(0, PARAGRAPH_CHARS)),
    "document",
    opts
  );
  if (!documents) return null;
  const vectors: number[][] = topics.map(() => []);
  open.forEach((topic, i) => {
    vectors[topic] = queries[i]!;
  });
  return assignTopicsByEmbedding(
    topics,
    paragraphs,
    { topics: vectors, paragraphs: documents },
    fixed
  );
}

/**
 * Rebuild printed-toc children from anchors plus embedding matches. Returns
 * null when the embeddings API is not configured or fails, so the caller
 * keeps verbatim.
 */
export async function placePrintedTocTopicsByEmbed(
  spoken: string,
  doc: ChaptersDocument,
  hint: ChapterHint,
  opts?: Omit<EmbedOptions, "signal"> & { budgetMs?: number }
): Promise<ChaptersDocument | null> {
  const config = opts?.config === undefined ? embedConfigFromEnv() : opts.config;
  if (!config || doc.source !== "printed-toc") return null;
  const budget = AbortSignal.timeout(opts?.budgetMs ?? TOPIC_EMBED_TOTAL_BUDGET_MS);
  return rebuildPrintedTocTopics(spoken, doc, hint, (topics, paragraphs, locked) =>
    placePartTopicsByEmbed(topics, paragraphs, {
      fetch: opts?.fetch,
      config,
      signal: budget,
      callTimeoutMs: opts?.callTimeoutMs,
      batchSize: opts?.batchSize,
      locked,
    })
  );
}
