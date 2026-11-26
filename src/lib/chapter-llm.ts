/**
 * Optional check for mid-score layout lines, and only those.
 *
 * The model never supplies a title. It may only label an id we sent as
 * heading, not_heading, or unsure. A reply that drops more than a fifth of
 * the high-confidence lines, or that swings the chapter count, is discarded
 * and the deterministic outline stands.
 *
 * Off unless `CHAPTER_LLM=1`. One short request, cheap model, eight-second cap.
 */

import type { ChaptersDocument } from "@/lib/book-chapters";
import { resolveChapters } from "@/lib/book-chapters";
import type { ChapterHint } from "@/lib/book-chapters";
import {
  layoutCandidateReport,
  trustedOutline,
  type LayoutCandidate,
  type LayoutFeatures,
} from "@/lib/chapter-layout";
import { openRouterChatUrl, unwrapJsonObject } from "@/lib/tts/openrouter-chat";

export const CHAPTER_LLM_MODEL = "google/gemini-2.5-flash-lite";
/** List price used for the per-book estimate. Not a measured invoice. */
export const CHAPTER_LLM_INPUT_USD_PER_M = 0.1;
export const CHAPTER_LLM_OUTPUT_USD_PER_M = 0.4;
const TIMEOUT_MS = 8_000;

export function chapterLlmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CHAPTER_LLM === "1";
}

export function chapterLlmModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.CHAPTER_LLM_MODEL?.trim() || CHAPTER_LLM_MODEL;
}

/**
 * Token estimate for one book. Input is the id, the features, and about
 * fifteen words of context per candidate. Output is a label per candidate.
 */
export function estimateChapterLlmCost(candidates: number): {
  inputTokens: number;
  outputTokens: number;
  usd: number;
} {
  const inputTokens = 160 + Math.max(0, candidates) * 45;
  const outputTokens = 24 + Math.max(0, candidates) * 16;
  const usd =
    (inputTokens * CHAPTER_LLM_INPUT_USD_PER_M + outputTokens * CHAPTER_LLM_OUTPUT_USD_PER_M) /
    1_000_000;
  return { inputTokens, outputTokens, usd };
}

export interface ChapterLlmDecision {
  id: string;
  label: "heading" | "not_heading" | "unsure";
  level?: number;
}

/**
 * Parse a verifier reply. Unknown ids, missing labels, and broken JSON reject
 * the whole reply. A title field, if the model adds one, is ignored.
 */
export function parseChapterLlmDecisions(
  raw: string,
  allowed: ReadonlySet<string>
): ChapterLlmDecision[] | null {
  let parsed: unknown;
  try {
    parsed = unwrapJsonObject(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const rows = (parsed as { decisions?: unknown }).decisions;
  if (!Array.isArray(rows)) return null;
  const decisions: ChapterLlmDecision[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") return null;
    const record = row as { id?: unknown; label?: unknown; level?: unknown };
    if (typeof record.id !== "string" || !allowed.has(record.id)) return null;
    if (record.label !== "heading" && record.label !== "not_heading" && record.label !== "unsure") {
      return null;
    }
    const level = typeof record.level === "number" && record.level >= 1 && record.level <= 3
      ? Math.round(record.level)
      : undefined;
    decisions.push({ id: record.id, label: record.label, ...(level ? { level } : {}) });
  }
  return decisions;
}

/**
 * True when the reply may replace the deterministic outline.
 * High-confidence headings are counted even though we do not remove them:
 * a model that rejects them is not trusted with the ambiguous ones either.
 */
export function chapterLlmGate(opts: {
  high: LayoutCandidate[];
  decisions: ChapterLlmDecision[];
  deterministicCount: number;
  nextCount: number;
}): boolean {
  if (opts.high.length > 0) {
    const rejected = opts.decisions.filter(
      (decision) =>
        decision.label === "not_heading" && opts.high.some((line) => line.id === decision.id)
    ).length;
    if (rejected / opts.high.length > 0.2) return false;
  }
  if (opts.deterministicCount >= 3) {
    const swing = Math.abs(opts.nextCount - opts.deterministicCount) / opts.deterministicCount;
    if (swing > 0.5) return false;
    if (opts.nextCount === 0) return false;
  }
  return true;
}

function promptFor(candidates: LayoutCandidate[]): string {
  const lines = candidates.map(
    (candidate) =>
      `${candidate.id} | ${candidate.features} | context: ${candidate.context || "(none)"}`
  );
  return [
    "You label candidate lines from a book. You do not write titles.",
    "Reply with JSON only: {\"decisions\":[{\"id\":\"...\",\"label\":\"heading\"|\"not_heading\"|\"unsure\",\"level\":1}]}",
    "Every id must be one of the ids below. Do not add ids. Do not return title text.",
    "level is 1 for a chapter and 2 for a subsection.",
    ...lines,
  ].join("\n");
}

export async function requestChapterLlmDecisions(
  candidates: LayoutCandidate[],
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<ChapterLlmDecision[] | null> {
  const key = env.OPENROUTER_API_KEY?.trim();
  if (!key || candidates.length === 0) return null;
  const allowed = new Set(candidates.map((candidate) => candidate.id));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(openRouterChatUrl(env), {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: chapterLlmModel(env),
        temperature: 0,
        messages: [{ role: "user", content: promptFor(candidates) }],
      }),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    return parseChapterLlmDecisions(content, allowed);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function countTop(doc: ChaptersDocument): number {
  return doc.chapters.length;
}

/**
 * Re-score only when this book had no trusted outline. Returns the original
 * document when the flag is off, the call fails, or the gate refuses.
 */
export async function maybeVerifyChapters(
  spoken: string,
  hint: ChapterHint,
  doc: ChaptersDocument,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<ChaptersDocument> {
  if (!chapterLlmEnabled(env) || !hint.layout) return doc;
  if (trustedOutline(hint, spoken.length)) return doc;
  if (
    doc.source === "epub-spine" ||
    doc.source === "pdf-outline" ||
    doc.source === "docx-heading" ||
    doc.source === "html-heading" ||
    doc.source === "sections"
  ) {
    return doc;
  }
  const report = layoutCandidateReport(hint.layout);
  if (report.ambiguous.length === 0) return doc;
  const sent = [...report.high, ...report.ambiguous];
  const decisions = await requestChapterLlmDecisions(sent, env, fetchImpl);
  if (!decisions) return doc;
  const ambiguous = new Set(report.ambiguous.map((line) => line.id));
  const rejectIds = decisions
    .filter((decision) => decision.label === "not_heading" && ambiguous.has(decision.id))
    .map((decision) => decision.id);
  const promoteIds = decisions
    .filter((decision) => decision.label === "heading" && ambiguous.has(decision.id))
    .map((decision) => decision.id);
  if (rejectIds.length === 0 && promoteIds.length === 0) return doc;
  const layout: LayoutFeatures = { ...hint.layout, rejectIds, promoteIds };
  const next = resolveChapters(spoken, { ...hint, layout });
  if (
    !chapterLlmGate({
      high: report.high,
      decisions,
      deterministicCount: countTop(doc),
      nextCount: countTop(next),
    })
  ) {
    return doc;
  }
  return next;
}
