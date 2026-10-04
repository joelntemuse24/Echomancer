/**
 * Low-confidence chapter choice.
 *
 * The model may only return indexes of headings that already exist in the
 * text. A missing key, a bad reply, or an unknown index leaves the offline
 * chapter list unchanged.
 */

import { playbackHeadingFlags } from "@/lib/tts/speakable-text";
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

const CHAT_URL =
  (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "") +
  "/chat/completions";

export interface ChapterCandidate {
  index: number;
  title: string;
  context: string;
}

function paragraphSpans(spoken: string): { text: string; start: number }[] {
  const text = spoken.replace(/\r\n/g, "\n");
  const spans: { text: string; start: number }[] = [];
  const re = /\n\s*\n/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    spans.push({ text: text.slice(start, match.index), start });
    start = match.index + match[0].length;
  }
  spans.push({ text: text.slice(start), start });
  return spans;
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
  }
  return out;
}

export function needsChapterChoice(spoken: string, doc: ChaptersDocument): boolean {
  if (
    doc.source === "printed-toc" ||
    doc.source === "epub-spine" ||
    doc.source === "pdf-outline" ||
    doc.source === "docx-heading"
  ) {
    return false;
  }
  const candidates = chapterCandidates(spoken);
  if (candidates.length < 8) return false;
  const junk = candidates.filter(
    (candidate) =>
      isDiscardedChapterTitle(candidate.title) || isMidPhraseChapterTitle(candidate.title)
  ).length;
  if (junk / candidates.length >= 0.3) return true;
  return candidates.length > Math.max(1, doc.chapters.length) * 2;
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
  fetchFn: typeof fetch
): Promise<string | null> {
  const response = await fetchFn(CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
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
  const lines = candidates
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
  try {
    const primary = await complete(apiKey, listenPrepModel(), "primary", prompt, fetchFn);
    const indexes = primary ? parseIndexes(primary, candidates.length) : null;
    if (indexes) return indexes;
    const fallback = await complete(
      apiKey,
      listenPrepFallbackModel(),
      "fallback",
      prompt,
      fetchFn
    );
    return fallback ? parseIndexes(fallback, candidates.length) : null;
  } catch {
    return null;
  }
}

/** Offline resolve, then the model only when the heading list looks junk-heavy. */
export async function resolveChaptersForBook(
  spoken: string,
  hint: ChapterHint,
  opts?: { fetch?: typeof fetch; apiKey?: string }
): Promise<ChaptersDocument> {
  const sync = resolveChapters(spoken, hint);
  if (!needsChapterChoice(spoken, sync)) return sync;
  const candidates = chapterCandidates(spoken);
  const indexes = await chooseChapterIndexes(
    candidates,
    hint.tocLines?.slice(0, 40) ?? hint.titles.map((title) => title.title).slice(0, 40),
    opts
  );
  if (!indexes) return sync;
  const chosen = chaptersFromCandidateIndexes(spoken, candidates, indexes);
  return chosen.chapters.length > 0 ? chosen : sync;
}
