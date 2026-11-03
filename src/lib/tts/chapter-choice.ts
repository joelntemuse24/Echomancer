/**
 * Low-confidence chapter choice.
 *
 * The model may only return indexes of headings that already exist in the
 * text. A missing key, a bad reply, or an unknown index leaves the offline
 * chapter list unchanged.
 */

import { playbackHeadingFlags } from "@/lib/tts/speakable-text";
import { paragraphSpans } from "@/lib/paragraph-spans";
import {
  chaptersForNarration,
  chaptersFromHeadingLines,
  isDiscardedChapterTitle,
  isMidPhraseChapterTitle,
  type BookChapter,
  type ChapterHint,
  type ChaptersDocument,
  resolveChapters,
} from "@/lib/book-chapters";
import {
  listenPrepFallbackModel,
  listenPrepModel,
  listenPrepProvider,
} from "@/lib/tts/listen-prep";
import { getOpenRouterApiKey } from "@/lib/tts/providers/openrouter";
import { resolveAiChapters, type ChapterAiHost } from "@/lib/tts/chapter-ai";
import { placePrintedTocTopicsByEmbed, topicEmbedEnabled } from "@/lib/tts/topic-embed";
import { placePrintedTocTopics, topicLlmEnabled } from "@/lib/tts/topic-llm";
import { openRouterChatUrl } from "@/lib/tts/openrouter-chat";

const CHAT_URL = openRouterChatUrl();

const CALL_TIMEOUT_MS = 15_000;
const TOTAL_BUDGET_MS = 30_000;
const MAX_CANDIDATES = 80;

export interface ChapterCandidate {
  index: number;
  title: string;
  context: string;
}

export function chapterCandidates(spoken: string): ChapterCandidate[] {
  const spans = paragraphSpans(spoken);
  const flags = playbackHeadingFlags(spans.map((span) => span.text.replace(/\s+/g, " ").trim()));
  const out: ChapterCandidate[] = [];
  for (let i = 0; i < spans.length; i++) {
    if (!flags[i]) continue;
    const title = spans[i]!.text.replace(/\s+/g, " ").trim();
    if (!title || title.length > 120) continue;
    const context = spans[i + 1]?.text.replace(/\s+/g, " ").trim().slice(0, 140) ?? "";
    out.push({ index: out.length, title, context });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

export function needsChapterChoice(
  spoken: string,
  doc: ChaptersDocument,
  /** Reuse a candidate list the caller already built. */
  precomputed?: ChapterCandidate[]
): boolean {
  if (
    doc.source === "ai" ||
    doc.source === "printed-toc" ||
    doc.source === "epub-spine" ||
    doc.source === "pdf-outline" ||
    doc.source === "docx-heading" ||
    doc.source === "html-heading" ||
    // Labelled length parts are the deliberate answer for a book with no
    // markers; asking a model to choose headings there would invent chapters.
    doc.source === "sections"
  ) {
    return false;
  }
  const candidates = precomputed ?? chapterCandidates(spoken);
  if (candidates.length < 8) return false;
  const junk = candidates.filter(
    (candidate) =>
      isDiscardedChapterTitle(candidate.title) || isMidPhraseChapterTitle(candidate.title)
  ).length;
  if (junk / candidates.length >= 0.3) return true;
  return candidates.length > Math.max(1, doc.chapters.length) * 2;
}

/**
 * Trust a nonempty source outline with ordered, in-range tree boundaries.
 *
 * `heading-lines` is included. It used to be excluded, which sent every book
 * whose chapters came from the deterministic detector to the model — even when
 * that detector had produced a correct, well-ordered outline. The model can
 * then replace it: measured with a stub that answers like a plausible model,
 * Pride and Prejudice's 65 detected chapters became 1. A caller that wants the
 * model's opinion anyway passes an explicit `forceAi`; a caller that only
 * wants a valid outline simply gets the one it already has.
 *
 * The AI path still runs for genuinely unmarked books, where `sync` has fewer
 * than two chapters and therefore no valid structure.
 */
export function hasValidChapterStructure(spoken: string, doc: ChaptersDocument): boolean {
  if (
    ![
      "epub-spine",
      "pdf-outline",
      "printed-toc",
      "ai",
      "docx-heading",
      "html-heading",
      "heading-lines",
      "sections",
    ].includes(doc.source)
  ) {
    return false;
  }
  const visit = (nodes: BookChapter[], from: number, end: number): boolean => {
    let previous = from - 1;
    return nodes.every((node, i) => {
      const next = nodes[i + 1]?.charStart ?? end;
      if (!node.title.trim() || !Number.isInteger(node.charStart) ||
          node.charStart < from || node.charStart <= previous || node.charStart >= end ||
          !Number.isInteger(node.charEnd) || node.charEnd <= node.charStart ||
          node.charEnd > spoken.length) return false;
      previous = node.charStart;
      return visit(node.children ?? [], node.charStart, next);
    });
  };
  return doc.chapters.length > 0 && visit(doc.chapters, 0, spoken.length);
}

export function chaptersFromCandidateIndexes(
  spoken: string,
  candidates: ChapterCandidate[],
  indexes: number[]
): ChaptersDocument {
  const allowed = new Set(indexes.filter((index) => index >= 0 && index < candidates.length));
  const chosen = [...allowed].sort((a, b) => a - b);
  const chapters: BookChapter[] = [];
  let searchFrom = 0;
  for (const index of chosen) {
    const title = candidates[index]!.title;
    const at = spoken.indexOf(title, searchFrom);
    if (at < 0) continue;
    chapters.push({
      index: chapters.length,
      title,
      level: 1,
      charStart: at,
      charEnd: spoken.length,
      match: title,
    });
    searchFrom = at + title.length;
  }
  const kept = chaptersForNarration(chapters, spoken);
  if (kept.length === 0) return chaptersFromHeadingLines(spoken);
  return { version: 1, source: "heading-lines", chapters: kept };
}

function parseIndexes(content: string, candidateCount: number): number[] | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(content.slice(start, end + 1)) as { indexes?: unknown };
    if (!Array.isArray(parsed.indexes)) return null;
    const indexes = parsed.indexes.filter(
      (index): index is number =>
        typeof index === "number" && Number.isInteger(index) && index >= 0 && index < candidateCount
    );
    return indexes.length > 0 ? indexes : null;
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
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
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

/**
 * Ask for indexes only. Returns null when there is no key or the reply
 * cannot be used. Unknown indexes are ignored.
 */
export async function chooseChapterIndexes(
  candidates: ChapterCandidate[],
  tocLabels: string[],
  opts?: { fetch?: typeof fetch; apiKey?: string }
): Promise<number[] | null> {
  const apiKey = opts?.apiKey ?? getOpenRouterApiKey();
  if (!apiKey || candidates.length === 0) return null;
  const fetchFn = opts?.fetch ?? fetch;
  const capped = candidates.slice(0, MAX_CANDIDATES);
  const lines = capped
    .map(
      (candidate) =>
        `${candidate.index}. ${candidate.title}${candidate.context ? ` — ${candidate.context}` : ""}`
    )
    .join("\n");
  const prompt = [
    "Pick the real chapter headings from this numbered list.",
    "Reply with JSON {\"indexes\":[...]} using only those numbers.",
    "Do not invent a heading or a position.",
    tocLabels.length ? `Contents labels: ${tocLabels.join("; ")}` : "",
    lines,
  ]
    .filter(Boolean)
    .join("\n");
  const budget = AbortSignal.timeout(TOTAL_BUDGET_MS);
  try {
    const primary = await complete(
      apiKey,
      listenPrepModel(),
      "primary",
      prompt,
      fetchFn,
      AbortSignal.any([AbortSignal.timeout(CALL_TIMEOUT_MS), budget])
    );
    const indexes = primary ? parseIndexes(primary, capped.length) : null;
    if (indexes) return indexes;
    const fallback = await complete(
      apiKey,
      listenPrepFallbackModel(),
      "fallback",
      prompt,
      fetchFn,
      AbortSignal.any([AbortSignal.timeout(CALL_TIMEOUT_MS), budget])
    );
    return fallback ? parseIndexes(fallback, capped.length) : null;
  } catch {
    return null;
  }
}

/** Offline resolve, then the model only when the heading list looks junk-heavy. */
export async function resolveChaptersForBook(
  spoken: string,
  hint: ChapterHint,
  opts?: {
    fetch?: typeof fetch;
    apiKey?: string;
    budgetMs?: number;
    callTimeoutMs?: number;
    minChars?: number;
    /**
     * Worker-only AI detection runs only for an explicit worker-side host:
     * `node` (VM extract child) or `worker` (freeze / rechapter). Any other
     * host — including an omitted one — keeps the offline path so Vercel and
     * the Cloudflare fallback never pay for a model call.
     */
    host?: ChapterAiHost;
    /**
     * Ask the model even when the offline outline is already valid. Only the
     * rechapter script wants this, to re-derive chapters for a finished book
     * whose stored outline came from the heuristic detector.
     */
    forceAi?: boolean;
  }
): Promise<ChaptersDocument> {
  const sync = resolveChapters(spoken, hint);
  const valid = hasValidChapterStructure(spoken, sync);
  if (valid && !opts?.forceAi) return sync;
  if (opts?.host === "node" || opts?.host === "worker") {
    try {
      const ai = await resolveAiChapters(spoken, hint, { ...opts, host: opts.host });
      // A forced run is the caller's answer: returning it stops the
      // candidate pass from asking the model a second time.
      if (ai && ai.chapters.length > 0) return ai;
    } catch {
      // Keep the offline outline when the provider fails.
    }
    // Forced and the model gave nothing usable: keep what we had.
    if (valid) return sync;
  }
  let doc = sync;
  if (sync.source === "printed-toc") {
    // Embedding placement is the intended path. The chat model runs only when
    // CHAPTER_TOPIC_LLM=1 and embeddings are off or gave up.
    let placed: ChaptersDocument | null = null;
    if (topicEmbedEnabled()) placed = await placePrintedTocTopicsByEmbed(spoken, sync, hint, opts);
    if (!placed && topicLlmEnabled()) placed = await placePrintedTocTopics(spoken, sync, hint, opts);
    if (placed) doc = placed;
  }
  // One candidate scan, not two: `needsChapterChoice` needs the same list the
  // choice itself does.
  const candidates = chapterCandidates(spoken);
  if (!needsChapterChoice(spoken, doc, candidates)) return doc;
  const indexes = await chooseChapterIndexes(
    candidates,
    hint.tocLines?.slice(0, 40) ?? hint.titles.map((title) => title.title).slice(0, 40),
    opts
  );
  if (!indexes) return doc;
  const chosen = chaptersFromCandidateIndexes(spoken, candidates, indexes);
  return chosen.chapters.length > 0 ? chosen : doc;
}
