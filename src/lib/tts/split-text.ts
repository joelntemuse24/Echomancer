/**
 * Map TTS windows onto book structure.
 *
 * `maxChars` is a *target*, not a knife. We pack paragraphs toward that
 * budget and only end a section on a semantic boundary:
 *   chapter heading > paragraph > sentence > word
 *
 * PDF page furniture (`Page 12`, `12 | 340`, `---`, form-feed) is layout,
 * not a speech boundary — it is dropped, never flushed on.
 *
 * A chapter heading always starts a new section. The title stays on the
 * first window of that chapter; the last paragraph of chapter N is never
 * glued onto chapter N+1.
 */

import { isChapterHeading, isSpeakableHeading } from "@/lib/tts/speakable-text";
import type { FrozenSection, SectionJoinKind } from "@/lib/tts/types";

/** Refuse a stub shorter than this share of the target when a later break exists. */
const MIN_FILL_RATIO = 0.55;

/** How far past the target we may run to reach the next paragraph. */
const OVERFLOW_RATIO = 0.25;
const OVERFLOW_MIN = 200;

export type SplitTextOptions = {
  /** Absolute ceiling. Defaults to target + overflow slack. */
  hardMaxChars?: number;
  /**
   * Take-home section 0 only. Live Listen uses `STREAM_WINDOW_CHARS` and
   * never calls this with a large Fish target.
   */
  firstSectionMaxChars?: number;
  /**
   * Payload size for the target / hard-max budget. Defaults to JS string
   * length (Fish / Edge). Google Whole-book passes UTF-8 bytes of the
   * final SSML so sections stay under Cloud TTS's 5000-byte input limit.
   */
  measure?: (text: string) => number;
};

export function hardMaxForTarget(targetChars: number): number {
  const slack = Math.max(OVERFLOW_MIN, Math.round(targetChars * OVERFLOW_RATIO));
  return Math.max(targetChars, targetChars + slack);
}

const PAGE_BREAK_TOKEN = "\u240c";

function normalizeBookText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u000c/g, "\n\n")
    .replace(/\u00a0/g, " ")
    .trim();
}

/** Layout leftovers — skip, do not speak, do not flush. */
export function isLayoutNoiseBlock(block: string): boolean {
  const t = block.trim();
  if (!t) return true;
  if (t === PAGE_BREAK_TOKEN || t === "\f" || t.includes("\f")) return true;
  if (/^page\s+\d+(?:\s+of\s+\d+)?$/i.test(t)) return true;
  if (/^\d+\s*\|\s*\d+$/.test(t)) return true;
  if (/^-{3,}$/.test(t)) return true;
  if (/^—\s*\d+\s*—$/.test(t)) return true;
  return false;
}

type BookUnit =
  | { kind: "heading"; text: string }
  | { kind: "para"; text: string };

function bookUnits(text: string): BookUnit[] {
  const normalized = normalizeBookText(text);
  if (!normalized) return [];

  const rawBlocks = normalized.split(/\n\s*\n/);
  const units: BookUnit[] = [];

  for (const raw of rawBlocks) {
    const block = raw.replace(/[^\S\n]+/g, " ").replace(/\n/g, " ").trim();
    if (!block) continue;
    if (isLayoutNoiseBlock(block)) continue;
    if (isChapterHeading(block) || isSpeakableHeading(block)) {
      units.push({ kind: "heading", text: block });
      continue;
    }
    units.push({ kind: "para", text: block });
  }

  return units;
}

function splitSentences(para: string): string[] {
  const parts = para.match(/[^.!?]+[.!?]+(?:["\u201d')\]]+)?\s*/g);
  if (!parts) return [para];
  const consumed = parts.join("").length;
  if (consumed < para.length) {
    const tail = para.slice(consumed).trim();
    return tail ? [...parts.map((p) => p.trim()), tail] : parts.map((p) => p.trim());
  }
  return parts.map((p) => p.trim()).filter(Boolean);
}

type SizeFn = (text: string) => number;

function prefixWithinBudget(text: string, limit: number, measure: SizeFn): number {
  if (!text) return 0;
  if (measure(text) <= limit) return text.length;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (measure(text.slice(0, mid)) <= limit) lo = mid;
    else hi = mid - 1;
  }
  if (lo <= 0) return Math.min(1, text.length);
  const sliced = text.slice(0, lo);
  const sp = sliced.lastIndexOf(" ");
  if (sp >= Math.floor(lo * 0.5)) return sp;
  return lo;
}

function splitRunToBudget(
  text: string,
  target: number,
  hardMax: number,
  measure: SizeFn
): string[] {
  const out: string[] = [];
  let rest = text;
  const limit = Math.max(1, Math.min(target, hardMax));
  while (rest) {
    if (measure(rest) <= hardMax) {
      out.push(rest);
      break;
    }
    const end = Math.max(1, prefixWithinBudget(rest, limit, measure));
    const head = rest.slice(0, end).trim();
    rest = rest.slice(end).trim();
    if (head) out.push(head);
  }
  return out.filter(Boolean);
}

function packBySize(
  pieces: string[],
  target: number,
  hardMax: number,
  joiner: string,
  measure: SizeFn
): string[] {
  const out: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim()) out.push(current.trim());
    current = "";
  };

  for (const piece of pieces) {
    if (!piece) continue;
    if (measure(piece) > hardMax) {
      flush();
      out.push(...splitRunToBudget(piece, target, hardMax, measure));
      continue;
    }

    const next = current ? current + joiner + piece : piece;
    if (!current) {
      current = piece;
      continue;
    }
    if (measure(next) <= target) {
      current = next;
      continue;
    }
    if (
      measure(next) <= hardMax &&
      measure(current) < target * MIN_FILL_RATIO
    ) {
      current = next;
      continue;
    }
    flush();
    current = piece;
  }
  flush();
  return out;
}

function splitOversizedParagraph(
  para: string,
  target: number,
  hardMax: number,
  measure: SizeFn
): string[] {
  if (measure(para) <= hardMax) return [para];

  const sentences = splitSentences(para);
  if (sentences.length > 1) {
    const packed = packBySize(sentences, target, hardMax, " ", measure);
    if (packed.every((p) => measure(p) <= hardMax)) return packed;
  }

  const words = para.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    return packBySize(words, target, hardMax, " ", measure);
  }

  return splitRunToBudget(para, target, hardMax, measure);
}

type OpenSection = {
  parts: string[];
  chapterIndex: number;
  chapterTitle: string | null;
  charStart: number;
  joinKind: SectionJoinKind;
};

function openSectionText(open: OpenSection): string {
  return open.parts.join("\n\n").trim();
}

/**
 * Chapter-aware packer. Prefer this when callers need offsets / join kind.
 * {@link splitTextForTts} is the string-only wrapper (Live Listen, tests).
 */
export function packSpeakableSections(
  text: string,
  maxChars: number,
  opts?: SplitTextOptions
): FrozenSection[] {
  if (maxChars < 10) maxChars = 10;
  const measure: SizeFn = opts?.measure ?? ((s) => s.length);
  const hardMax = Math.max(
    maxChars,
    opts?.hardMaxChars ?? hardMaxForTarget(maxChars)
  );
  const firstTarget =
    typeof opts?.firstSectionMaxChars === "number" &&
    opts.firstSectionMaxChars >= 10
      ? Math.min(opts.firstSectionMaxChars, maxChars)
      : maxChars;

  const units = bookUnits(text);
  if (units.length === 0) return [];

  const finished: FrozenSection[] = [];
  let chapterIndex = 0;
  let chapterTitle: string | null = null;
  let cursor = 0;
  let open: OpenSection | null = null;
  let seenContent = false;

  const emit = (section: OpenSection) => {
    const body = openSectionText(section);
    if (!body) return;
    const charStart = section.charStart;
    const charEnd = charStart + body.length;
    finished.push({
      index: finished.length,
      text: body,
      chapterIndex: section.chapterIndex,
      chapterTitle: section.chapterTitle,
      charStart,
      charEnd,
      joinKind: section.joinKind,
    });
    cursor = charEnd;
  };

  const startOpen = (
    first: string,
    joinKind: SectionJoinKind,
    nextChapterIndex: number,
    nextTitle: string | null
  ) => {
    open = {
      parts: [first],
      chapterIndex: nextChapterIndex,
      chapterTitle: nextTitle,
      charStart: cursor,
      joinKind,
    };
  };

  const targetForNext = () => (finished.length === 0 ? firstTarget : maxChars);

  /** First-section TTFA uses a tight ceiling; later windows only mid-split at hardMax. */
  const overflowCeiling = () => {
    const target = targetForNext();
    if (finished.length === 0) {
      return Math.min(hardMax, target + Math.max(80, Math.round(target * 0.08)));
    }
    return hardMax;
  };

  for (const unit of units) {
    if (unit.kind === "heading") {
      if (open) emit(open);
      if (seenContent) chapterIndex += 1;
      chapterTitle = unit.text;
      startOpen(unit.text, "chapter", chapterIndex, chapterTitle);
      seenContent = true;
      continue;
    }

    const target = targetForNext();
    const splitAt = overflowCeiling();
    const pieces =
      measure(unit.text) > splitAt
        ? splitOversizedParagraph(unit.text, target, splitAt, measure)
        : [unit.text];

    for (let p = 0; p < pieces.length; p++) {
      const piece = pieces[p]!;
      const joinKind: SectionJoinKind =
        p === 0 ? "paragraph" : "mid-paragraph";

      if (!open) {
        startOpen(piece, joinKind, chapterIndex, chapterTitle);
        seenContent = true;
        continue;
      }

      const currentOpen: OpenSection = open;
      const current = openSectionText(currentOpen);
      const nextJoined = current ? `${current}\n\n${piece}` : piece;
      const nextLen = measure(nextJoined);
      const currentLen = measure(current);
      const effectiveTarget = targetForNext();

      if (nextLen <= effectiveTarget) {
        currentOpen.parts.push(piece);
        continue;
      }

      const filledEnough = currentLen >= effectiveTarget * MIN_FILL_RATIO;
      if (filledEnough || nextLen > overflowCeiling()) {
        emit(currentOpen);
        startOpen(piece, joinKind, chapterIndex, null);
        continue;
      }

      currentOpen.parts.push(piece);
    }
  }

  if (open) emit(open);
  return finished;
}

export function splitTextForTts(
  text: string,
  maxChars: number,
  opts?: SplitTextOptions
): string[] {
  return packSpeakableSections(text, maxChars, opts).map((s) => s.text);
}
