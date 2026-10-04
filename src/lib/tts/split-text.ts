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
 * A chapter heading starts a new section once the open one already holds
 * about {@link MIN_SECTION_CHARS}. A shorter heading stays in the section
 * as a marker (`chapterMarks`), timed from its text offset. The first
 * section is capped near {@link FIRST_SECTION_CHARS} so audio starts
 * quickly, and it still will not close on a 27-character title.
 */

import {
  CONTENTS_HEADING_RUN,
  headingLineMatches,
  narrationHeadingFlags,
} from "@/lib/book-chapters";
import { isBodyHeadingBlock } from "@/lib/printed-toc";
import { stripNarrationFrontMatter } from "@/lib/tts/front-matter";
import { FIRST_SECTION_CHARS, MIN_SECTION_CHARS } from "@/lib/tts/section-size";
import {
  isAbbreviationBoundary,
  isContentsEntryLine,
  playbackHeadingFlags,
} from "@/lib/tts/speakable-text";
import type { FrozenChapterMark, FrozenSection, SectionJoinKind } from "@/lib/tts/types";

/** Refuse a stub shorter than this share of the target when a later break exists. */
const MIN_FILL_RATIO = 0.55;

/** How far past the target we may run to reach the next paragraph. */
const OVERFLOW_RATIO = 0.25;
const OVERFLOW_MIN = 200;

export type SplitTextOptions = {
  /** Absolute ceiling. Defaults to target + overflow slack. */
  hardMaxChars?: number;
  /**
   * Take-home section 0 only. Defaults to {@link FIRST_SECTION_CHARS} when
   * the target is larger. Live Listen passes a window already under that.
   */
  firstSectionMaxChars?: number;
  /**
   * Drop a leading copyright / ISBN page. Defaults to on.
   * `TTS_SKIP_FRONT_MATTER=0` turns it off for every caller.
   */
  skipFrontMatter?: boolean;
  /**
   * Payload size for the target / hard-max budget. Defaults to JS string
   * length (Fish / Edge). Google Whole-book passes UTF-8 bytes of the
   * final SSML so sections stay under Cloud TTS's 5000-byte input limit.
   */
  measure?: (text: string) => number;
  /**
   * Stored chapter outline (extraction's chapters.json). When at least half
   * the entries match a paragraph, those paragraphs — and only those — are
   * treated as chapter headings, and the stored display title replaces the
   * source line. Below that, heading detection runs as before.
   */
  chapters?: { match: string; title: string }[];
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

/**
 * Scene breaks are layout, same as a dash rule. They are not spoken.
 * `***`, `* * *`, and `---` all match. A page marker like `— 42 —` does not.
 */
export function isSceneBreakMarker(block: string): boolean {
  const t = block.trim();
  if (!t) return false;
  if (/^(?:[-–—]\s*){3,}$/.test(t)) return true;
  if (/^(?:\*\s*){3,}$/.test(t)) return true;
  return false;
}

/** Layout leftovers — skip, do not speak, do not flush. */
export function isLayoutNoiseBlock(block: string): boolean {
  const t = block.trim();
  if (!t) return true;
  if (t === PAGE_BREAK_TOKEN || t === "\f" || t.includes("\f")) return true;
  if (/^page\s+\d+(?:\s+of\s+\d+)?$/i.test(t)) return true;
  if (/^\d+\s*\|\s*\d+$/.test(t)) return true;
  if (isSceneBreakMarker(t)) return true;
  if (/^—\s*\d+\s*—$/.test(t)) return true;
  return false;
}

type BookUnit =
  | { kind: "heading"; text: string; title?: string }
  | { kind: "para"; text: string };

/** Exact, or a bounded prefix when a neighbour line was glued onto the heading. */
function chapterLineMatches(block: string, wanted: string): boolean {
  return headingLineMatches(block, wanted);
}

/** How many outline entries may be skipped when one is missing from the text. */
const FORCED_CHAPTER_LOOKAHEAD = 12;

/**
 * Walk the stored outline in order against the paragraphs. Returns null when
 * under half the outline matched — the outline then describes another text
 * (stale chapters.json) and heading detection is the safer source.
 */
function forcedHeadingPlan(
  blocks: string[],
  chapters: { match: string; title: string }[]
): { flags: boolean[]; titles: (string | undefined)[] } | null {
  const flags: boolean[] = new Array(blocks.length).fill(false);
  const titles: (string | undefined)[] = new Array(blocks.length).fill(undefined);
  const isOutlineLine = (block: string) =>
    chapters.some((chapter) => chapterLineMatches(block, chapter.match));
  let next = 0;
  let matched = 0;
  for (let i = 0; i < blocks.length && next < chapters.length; i++) {
    if (isContentsEntryLine(blocks[i]!)) continue;
    // A contents row is an outline label whose next block is another
    // outline label. The body heading is the one followed by prose, so a
    // contents table that sits directly above the first chapter is not
    // swallowed together with that chapter.
    let run = 0;
    while (
      i + run + 1 < blocks.length &&
      isOutlineLine(blocks[i + run]!) &&
      isOutlineLine(blocks[i + run + 1]!)
    ) {
      run += 1;
    }
    if (run >= CONTENTS_HEADING_RUN) {
      i += run - 1;
      continue;
    }
    const stop = Math.min(next + FORCED_CHAPTER_LOOKAHEAD, chapters.length);
    let hit = -1;
    for (let j = next; j < stop; j++) {
      if (chapterLineMatches(blocks[i]!, chapters[j]!.match)) {
        hit = j;
        break;
      }
    }
    if (hit < 0) continue;
    const match = chapters[hit]!.match;
    let again = false;
    for (let j = i + 1; j < blocks.length; j++) {
      if (chapterLineMatches(blocks[j]!, match)) {
        again = true;
        break;
      }
    }
    if (again && !isBodyHeadingBlock(blocks, i)) continue;
    flags[i] = true;
    titles[i] = chapters[hit]!.title;
    matched += 1;
    next = hit + 1;
  }
  const needed = Math.max(1, Math.ceil(chapters.length * 0.5));
  return matched >= needed ? { flags, titles } : null;
}

function bookUnits(
  text: string,
  chapters?: { match: string; title: string }[]
): BookUnit[] {
  const normalized = normalizeBookText(text);
  if (!normalized) return [];

  const rawBlocks = normalized.split(/\n\s*\n/);
  const cleaned: string[] = [];
  for (const raw of rawBlocks) {
    const block = raw.replace(/[^\S\n]+/g, " ").replace(/\n/g, " ").trim();
    if (!block || isLayoutNoiseBlock(block)) continue;
    cleaned.push(block);
  }
  const forced = chapters?.length ? forcedHeadingPlan(cleaned, chapters) : null;
  const detected = forced?.flags ?? playbackHeadingFlags(cleaned);
  const flags = narrationHeadingFlags(cleaned, detected, forced?.titles);
  const units: BookUnit[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    units.push(
      flags[i]
        ? { kind: "heading", text: cleaned[i]!, title: forced?.titles[i] }
        : { kind: "para", text: cleaned[i]! }
    );
  }

  return units;
}

function splitSentences(para: string): string[] {
  const parts = para.match(/[^.!?]+[.!?]+(?:["\u201d')\]]+)?\s*/g);
  if (!parts) return [para];
  const consumed = parts.join("").length;
  const raw =
    consumed < para.length ? [...parts, para.slice(consumed)] : [...parts];
  const merged: string[] = [];
  for (const part of raw) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      isAbbreviationBoundary(prev.trimEnd(), part.trimStart())
    ) {
      merged[merged.length - 1] = prev + part;
      continue;
    }
    merged.push(part);
  }
  return merged.map((p) => p.trim()).filter(Boolean);
}

type SizeFn = (text: string) => number;

function endsWithSentence(text: string): boolean {
  return /[.!?]["\u201d\u2019')\]]*$/.test(text.trim());
}

/**
 * Offset just past the last complete sentence of `piece` that keeps
 * `current + piece` within `limit`. Zero when the first sentence does not
 * fit. Never a word boundary.
 */
function sentencePrefixThatFits(
  current: string,
  piece: string,
  limit: number,
  measure: SizeFn
): number {
  const joiner = current ? "\n\n" : "";
  let searchFrom = 0;
  let best = 0;
  for (const sentence of splitSentences(piece)) {
    if (!endsWithSentence(sentence)) break;
    const at = piece.indexOf(sentence, searchFrom);
    if (at < 0) break;
    const end = at + sentence.length;
    const head = piece.slice(0, end).trim();
    if (!head || measure(`${current}${joiner}${head}`) > limit) break;
    best = end;
    searchFrom = end;
  }
  return best;
}

/** Offset just past the first complete sentence, or the whole piece when it has none. */
function throughNextSentence(piece: string): number {
  const sentence = splitSentences(piece).find((part) => part.length > 0);
  if (!sentence || !endsWithSentence(sentence)) return piece.length;
  const at = piece.indexOf(sentence);
  if (at < 0) return piece.length;
  return at + sentence.length;
}

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

/**
 * Pack a paragraph that is longer than the section ceiling into sentence
 * groups. A sentence longer than the provider hard max is the only case
 * that may split a word; ordinary prose stays on sentence ends.
 */
function packSentencesWithin(
  para: string,
  target: number,
  hardMax: number,
  measure: SizeFn
): string[] {
  const sentences = splitSentences(para);
  if (sentences.length <= 1) {
    if (measure(para) <= hardMax) return [para];
    return splitOversizedParagraph(para, target, hardMax, measure);
  }
  if (sentences.some((sentence) => measure(sentence) > hardMax)) {
    return splitOversizedParagraph(para, target, hardMax, measure);
  }
  return packBySize(sentences, target, hardMax, " ", measure);
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
  marks: FrozenChapterMark[];
};

function openSectionText(section: OpenSection): string {
  return section.parts.join("\n\n").trim();
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
  const requestedFirst = opts?.firstSectionMaxChars;
  const firstTarget =
    typeof requestedFirst === "number" && requestedFirst >= 10
      ? Math.min(requestedFirst, maxChars)
      : Math.min(FIRST_SECTION_CHARS, maxChars);

  const source =
    opts?.skipFrontMatter === false ? text : stripNarrationFrontMatter(text);
  const units = bookUnits(source, opts?.chapters);
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
      ...(section.marks.length > 0 ? { chapterMarks: section.marks } : {}),
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
      marks: [],
    };
  };

  const targetForNext = () => (finished.length === 0 ? firstTarget : maxChars);

  /** First-section TTFA uses a tight ceiling; later windows only mid-split at hardMax. */
  const overflowCeiling = () => {
    const target = targetForNext();
    if (finished.length === 0) {
      return Math.min(hardMax, target + 80);
    }
    return hardMax;
  };

  for (const unit of units) {
    if (unit.kind === "heading") {
      const title = unit.title ?? unit.text;
      const absorbing = open;
      const breakAt =
        finished.length === 0 ? Math.min(firstTarget, MIN_SECTION_CHARS) : MIN_SECTION_CHARS;
      if (absorbing !== null) {
        const held: OpenSection = absorbing;
        const body = openSectionText(held);
        if (measure(body) < breakAt) {
          if (seenContent) chapterIndex += 1;
          chapterTitle = title;
          const charOffset = body.length === 0 ? 0 : body.length + 2;
          held.marks.push({ chapterIndex, title, charOffset });
          held.parts.push(unit.text);
          seenContent = true;
          continue;
        }
      }
      if (open) emit(open);
      if (seenContent) chapterIndex += 1;
      chapterTitle = title;
      startOpen(unit.text, "chapter", chapterIndex, chapterTitle);
      seenContent = true;
      continue;
    }

    const target = targetForNext();
    const ceiling = finished.length === 0 ? overflowCeiling() : hardMax;
    const pieces =
      measure(unit.text) > ceiling
        ? packSentencesWithin(unit.text, target, hardMax, measure)
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

      // The first take-home window should land near its target. A 55% fill
      // would close a ~450-character paragraph and leave the opening short.
      const fillRatio =
        finished.length === 0 && firstTarget >= FIRST_SECTION_CHARS ? 0.9 : MIN_FILL_RATIO;
      const filledEnough = currentLen >= effectiveTarget * fillRatio;
      // A long next paragraph used to flush a short title on its own.
      // Take whole sentences that fit. If none fit, keep a stub open through
      // the next sentence end, or close a section that already has a body.
      // Never cut a word in the middle of a sentence.
      if (!filledEnough && nextLen > overflowCeiling()) {
        const fitted = sentencePrefixThatFits(current, piece, overflowCeiling(), measure);
        const stub = currentLen < Math.min(400, effectiveTarget * 0.5);
        const end = fitted > 0 ? fitted : stub ? throughNextSentence(piece) : 0;
        if (end > 0) {
          const head = piece.slice(0, end).trim();
          const rest = piece.slice(end).trim();
          const joined = head ? `${current}\n\n${head}` : current;
          if (head && measure(joined) <= hardMax) {
            currentOpen.parts.push(head);
            emit(currentOpen);
            if (rest) startOpen(rest, "mid-paragraph", chapterIndex, null);
            else open = null;
            continue;
          }
        }
        emit(currentOpen);
        startOpen(piece, joinKind, chapterIndex, null);
        continue;
      }
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

function sectionMeasure(section: FrozenSection, measure: (text: string) => number): number {
  return measure(section.text);
}

function reindexPacked(sections: FrozenSection[]): FrozenSection[] {
  let cursor = 0;
  return sections.map((section, index) => {
    const text = section.text.trim();
    const charStart = cursor;
    const charEnd = charStart + text.length;
    cursor = charEnd;
    return { ...section, index, text, charStart, charEnd };
  });
}

/**
 * Fish concurrency is 5. A short tail after a full wave waits for its own
 * round. Fold that tail back into the previous section when it is the same
 * chapter and the result stays under the hard max. A full extra section, or
 * one that would join two chapters, stays where the packer put it.
 */
export function absorbSmallFanoutRemainder(
  sections: FrozenSection[],
  opts: { fanout: number; hardMaxChars: number; measure?: (text: string) => number }
): FrozenSection[] {
  const fanout = Math.max(1, Math.floor(opts.fanout));
  const measure = opts.measure ?? ((text: string) => text.length);
  if (fanout < 2 || sections.length <= fanout || sections.length % fanout === 0) {
    return sections;
  }
  const lengths = sections.map((section) => sectionMeasure(section, measure));
  const sorted = [...lengths].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 1;
  let packed = sections.map((section) => ({ ...section }));
  let guard = 0;
  while (packed.length > fanout && packed.length % fanout !== 0 && guard++ < fanout) {
    const last = packed[packed.length - 1]!;
    const prev = packed[packed.length - 2]!;
    if (last.chapterIndex !== prev.chapterIndex) break;
    if (sectionMeasure(last, measure) > median * 0.7) break;
    const prevText = prev.text.trim();
    const lastText = last.text.trim();
    const joined = `${prevText}\n\n${lastText}`;
    if (measure(joined) > opts.hardMaxChars) break;
    const shift = prevText.length + 2;
    const marks = [
      ...(prev.chapterMarks ?? []),
      ...(last.chapterMarks ?? []).map((mark) => ({
        ...mark,
        charOffset: mark.charOffset + shift,
      })),
    ];
    packed = [
      ...packed.slice(0, -2),
      {
        ...prev,
        text: joined,
        charEnd: prev.charStart + joined.length,
        ...(marks.length > 0 ? { chapterMarks: marks } : {}),
      },
    ];
  }
  if (packed.length === sections.length) return sections;
  return reindexPacked(packed);
}
