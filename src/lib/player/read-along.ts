/**
 * Read-along transcript from text the job already has.
 *
 * Cue tags are display-only noise. Timing uses the measured section clock
 * (`section-starts.json`, the same MP3-frame clock chapters use) when every
 * section has one, scaled provider hints when it does not, and a
 * time-proportional walk of the whole text only as a last resort. Inside a
 * section, time maps over sentence weights — speakable characters plus the
 * paragraph-break pauses the synth turns into silence — instead of raw
 * characters, so the highlight survives the pauses that linear timing
 * ignores. Nothing here synthesizes or retags.
 */

import { stripAllSquareCues, stripFishS2Cues } from "@/lib/tts/fish-s2-cues";
import {
  isChapterHeading,
  isSpeakableHeading,
  stripUnspeakableTokens,
} from "@/lib/tts/speakable-text";
import { SSML_LONG_BREAK_MS } from "@/lib/tts/ssml-pauses";
import { scaleSectionStarts } from "@/lib/tts/section-clock";

export type TranscriptBlockKind = "chapter" | "paragraph";

export interface TranscriptBlock {
  id: string;
  kind: TranscriptBlockKind;
  /** 1 for a chapter or part title, 2 for a smaller heading. */
  level: 1 | 2;
  text: string;
  charStart: number;
  charEnd: number;
  sectionIndex: number | null;
}

/** One sentence inside a section: readable-text offsets and its time weight. */
export interface TranscriptSentence {
  /** Offset into the section's readable text where the sentence starts. */
  start: number;
  /** Speakable characters (cues and unspeakable tokens excluded). */
  weight: number;
  /** Silence after the sentence: paragraph breaks the synth pauses on. */
  pauseAfter: number;
}

export interface TranscriptSection {
  index: number;
  charStart: number;
  charEnd: number;
  /** Full-file clock duration. Hints when no measured clock exists. */
  durationSeconds: number | null;
  /** Measured start on the finished-file clock, when it exists. */
  startSeconds: number | null;
  /** Sentence timing for this section, offsets relative to charStart. */
  sentences: TranscriptSentence[];
}

export interface ReadAlongDocument {
  blocks: TranscriptBlock[];
  charCount: number;
  sections: TranscriptSection[];
}

export type ReadAlongMode = "full" | "section" | "stream";

export interface ReadAlongPosition {
  mode: ReadAlongMode;
  currentTime: number;
  duration: number;
  sectionIndex: number | null;
  streamCursor: number | null;
}

export interface FrozenTranscriptSection {
  index: number;
  text: string;
  durationSeconds?: number | null;
}

/** Measured section starts on the finished-file clock, when finalize wrote them. */
export interface MeasuredSectionStarts {
  sectionStarts: number[];
  totalSeconds: number;
}

function paragraphShape(text: string): { kind: TranscriptBlockKind; level: 1 | 2 } {
  if (!(isChapterHeading(text) || isSpeakableHeading(text))) {
    return { kind: "paragraph", level: 1 };
  }
  const level = /^(?:chapter|part)\b/i.test(text) ? 1 : 2;
  return { kind: "chapter", level };
}

/** Split readable text into chapter headings and paragraphs with char offsets. */
export function blocksFromReadable(
  text: string,
  sectionIndex: number | null = null
): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  const re = /\n\s*\n/g;
  let start = 0;
  let match: RegExpExecArray | null;
  const push = (raw: string, from: number) => {
    const leading = raw.match(/^\s*/)?.[0].length ?? 0;
    const trimmed = raw.trim();
    if (!trimmed) return;
    const charStart = from + leading;
    const shape = paragraphShape(trimmed);
    blocks.push({
      id: `b${blocks.length}`,
      kind: shape.kind,
      level: shape.level,
      text: trimmed,
      charStart,
      charEnd: charStart + trimmed.length,
      sectionIndex,
    });
  };
  while ((match = re.exec(text))) {
    push(text.slice(start, match.index), start);
    start = match.index + match[0].length;
  }
  push(text.slice(start), start);
  return blocks;
}

function withSectionIndex(
  blocks: TranscriptBlock[],
  sections: TranscriptSection[]
): TranscriptBlock[] {
  if (sections.length === 0) return blocks;
  return blocks.map((block) => {
    const section = sections.find(
      (item) => block.charStart >= item.charStart && block.charStart < item.charEnd
    );
    return section ? { ...block, sectionIndex: section.index } : block;
  });
}

/** A sentence ends here unless the period belongs to a title or initial. */
const ABBREV_BEFORE_PERIOD =
  /(?:^|\s)(?:mr|mrs|ms|dr|st|jr|sr|vs|etc)\.?$/i;

function skipWhitespace(text: string, from: number): number {
  let i = Math.max(0, Math.min(text.length, from));
  while (i < text.length && /\s/.test(text[i]!)) i += 1;
  return i;
}

/**
 * Sentence boundaries as readable-text offsets. Abbreviations (Mr., Dr.,
 * St., …) do not split. Offsets are stable: callers store them, so the
 * client maps time without the section text.
 */
export function sentenceSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const re = /[.!?…]+["”’)\]]*\s+/g;
  let start = skipWhitespace(text, 0);
  let match: RegExpExecArray | null;
  const pushTo = (end: number) => {
    let trimmedEnd = end;
    while (trimmedEnd > start && /\s/.test(text[trimmedEnd - 1]!)) trimmedEnd -= 1;
    if (trimmedEnd > start) spans.push({ start, end: trimmedEnd });
    start = skipWhitespace(text, end);
  };
  while ((match = re.exec(text))) {
    const before = text.slice(Math.max(0, match.index - 5), match.index + 1);
    if (ABBREV_BEFORE_PERIOD.test(before)) continue;
    pushTo(match.index + match[0].length);
  }
  pushTo(text.length);
  return spans;
}

function speakableLength(value: string): number {
  return stripUnspeakableTokens(stripAllSquareCues(value)).replace(/\s+/g, " ").trim().length;
}

/**
 * Sentence weights for one readable section. A sentence that ends its
 * paragraph carries the pause the synth turns into silence (same pause the
 * chapter clock counts for headings), so accumulated paragraph breaks stop
 * pushing later sentences late.
 */
export function sentenceWeights(sectionText: string): TranscriptSentence[] {
  const spans = sentenceSpans(sectionText);
  return spans.map((span, i) => {
    const slice = sectionText.slice(span.start, span.end);
    const next = spans[i + 1];
    const gap = next ? sectionText.slice(span.end, next.start) : "";
    return {
      start: span.start,
      weight: speakableLength(slice),
      pauseAfter: next && /\n[ \t]*\n/.test(gap) ? SSML_LONG_BREAK_MS / 1000 : 0,
    };
  });
}

/** Boundary tolerance between the time and seek walks (float association noise). */
const EPSILON_SECONDS = 1e-9;

function speechBudget(
  sentences: TranscriptSentence[],
  duration: number
): { speechSeconds: number; pauseScale: number; speechChars: number } {
  const speechChars = sentences.reduce((sum, sentence) => sum + sentence.weight, 0);
  const pauseAll = sentences.reduce((sum, sentence) => sum + sentence.pauseAfter, 0);
  const pauseBudget = Math.min(pauseAll, duration * 0.5);
  return {
    speechSeconds: Math.max(0, duration - pauseBudget),
    pauseScale: pauseAll > 0 ? pauseBudget / pauseAll : 0,
    speechChars,
  };
}

/**
 * Readable-text offset for seconds into a section. Returns the containing
 * sentence's start, so the highlight snaps to sentence beginnings instead
 * of drifting mid-sentence.
 */
export function sectionCharAtSeconds(
  section: TranscriptSection,
  localSeconds: number,
  duration: number
): number {
  const span = Math.max(1, section.charEnd - section.charStart);
  if (!(duration > 0)) return section.charStart;
  const at = Math.max(0, Math.min(duration, localSeconds));
  if (at <= 0) return section.charStart;
  if (at >= duration) return section.charEnd - 1;
  const sentences = section.sentences;
  if (sentences.length === 0) {
    return section.charStart + Math.min(span - 1, Math.floor((at / duration) * span));
  }
  const { speechSeconds, pauseScale, speechChars } = speechBudget(sentences, duration);
  if (!(speechChars > 0)) return section.charStart;
  let cursor = 0;
  for (const sentence of sentences) {
    const speech = (sentence.weight / speechChars) * speechSeconds;
    // A time exactly on a boundary belongs to the later sentence. The
    // epsilon absorbs float association noise between this walk and the
    // seek-direction walk so a tapped sentence maps back to itself.
    if (at < cursor + speech + sentence.pauseAfter * pauseScale - EPSILON_SECONDS) {
      return section.charStart + sentence.start;
    }
    cursor += speech + sentence.pauseAfter * pauseScale;
  }
  return section.charEnd - 1;
}

/** Seconds into a section for a readable-text offset (the seek direction). */
export function sectionSecondsAtChar(
  section: TranscriptSection,
  charOffset: number,
  duration: number
): number {
  const span = Math.max(1, section.charEnd - section.charStart);
  if (!(duration > 0)) return 0;
  const rel = Math.max(0, Math.min(span, charOffset - section.charStart));
  const sentences = section.sentences;
  if (sentences.length === 0) return (rel / span) * duration;
  const { speechSeconds, pauseScale, speechChars } = speechBudget(sentences, duration);
  if (!(speechChars > 0)) return (rel / span) * duration;
  let cursor = 0;
  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i]!;
    const nextStart =
      i + 1 < sentences.length ? sentences[i + 1]!.start : span;
    const speech = (sentence.weight / speechChars) * speechSeconds;
    if (rel < nextStart || i === sentences.length - 1) {
      const into = Math.max(0, Math.min(nextStart - sentence.start, rel - sentence.start));
      const frac = nextStart > sentence.start ? into / (nextStart - sentence.start) : 0;
      return Math.min(duration, cursor + frac * speech);
    }
    cursor += speech + sentence.pauseAfter * pauseScale;
  }
  return duration;
}

/**
 * Per-section clock on the finished-file timeline. Measured starts win when
 * every section has one; otherwise hint durations are scaled to the measured
 * total (or their own sum), so section boundaries sit on the file the
 * listener is actually hearing instead of drifting with provider estimates.
 */
export function resolveSectionClock(
  count: number,
  hints: Array<number | null>,
  measured: MeasuredSectionStarts | null,
  totalSeconds?: number | null
): Array<{ startSeconds: number | null; durationSeconds: number | null }> {
  const empty = Array.from({ length: count }, () => ({
    startSeconds: null as number | null,
    durationSeconds: null as number | null,
  }));
  if (count <= 0) return empty;
  if (measured && measured.totalSeconds > 0) {
    let complete = true;
    for (let i = 0; i < count; i++) {
      const start = measured.sectionStarts[i];
      if (typeof start !== "number" || !Number.isFinite(start)) {
        complete = false;
        break;
      }
    }
    if (complete) {
      return Array.from({ length: count }, (_, i) => {
        const start = measured!.sectionStarts[i]!;
        let next = measured!.totalSeconds;
        for (let j = i + 1; j < count; j++) {
          const candidate = measured!.sectionStarts[j];
          if (typeof candidate === "number" && Number.isFinite(candidate)) {
            next = candidate;
            break;
          }
        }
        return {
          startSeconds: start,
          durationSeconds: Math.max(0, next - start),
        };
      });
    }
  }
  const hintSeconds = hints.map((hint) =>
    typeof hint === "number" && hint > 0 ? hint : 0
  );
  if (!hintSeconds.some((hint) => hint > 0)) return empty;
  const total =
    measured && measured.totalSeconds > 0
      ? measured.totalSeconds
      : totalSeconds && totalSeconds > 0
        ? totalSeconds
        : null;
  const clock = scaleSectionStarts(
    hintSeconds,
    total ?? hintSeconds.reduce((sum, hint) => sum + hint, 0)
  );
  return clock.sectionStarts.map((start, i) => ({
    startSeconds: start,
    durationSeconds:
      i + 1 < clock.sectionStarts.length
        ? Math.max(0, clock.sectionStarts[i + 1]! - start)
        : Math.max(0, clock.totalSeconds - start),
  }));
}

/**
 * Prefer the frozen speakable (what was actually narrated). Fall back to the
 * extracted book when the freeze has not been written yet.
 */
export function buildReadAlongDocument(input: {
  contentText?: string | null;
  frozenSections?: FrozenTranscriptSection[] | null;
  measuredStarts?: MeasuredSectionStarts | null;
  totalSeconds?: number | null;
}): ReadAlongDocument {
  const frozen = (input.frozenSections || []).filter(
    (section) => section.text.trim().length > 0
  );
  if (frozen.length > 0) {
    const parts: string[] = [];
    const ranges: Array<{ index: number; charStart: number; charEnd: number; text: string }> = [];
    let cursor = 0;
    for (const section of frozen) {
      const readable = stripFishS2Cues(section.text);
      if (!readable) continue;
      if (parts.length > 0) {
        parts.push("\n\n");
        cursor += 2;
      }
      const charStart = cursor;
      parts.push(readable);
      cursor += readable.length;
      ranges.push({ index: section.index, charStart, charEnd: cursor, text: readable });
    }
    const clock = resolveSectionClock(
      ranges.length,
      frozen.map((section) =>
        typeof section.durationSeconds === "number" && section.durationSeconds > 0
          ? section.durationSeconds
          : null
      ),
      input.measuredStarts ?? null,
      input.totalSeconds ?? null
    );
    const sections: TranscriptSection[] = ranges.map((range, i) => ({
      index: range.index,
      charStart: range.charStart,
      charEnd: range.charEnd,
      durationSeconds: clock[i]?.durationSeconds ?? null,
      startSeconds: clock[i]?.startSeconds ?? null,
      sentences: sentenceWeights(range.text),
    }));
    const text = parts.join("");
    const blocks = withSectionIndex(blocksFromReadable(text), sections);
    return { blocks, charCount: text.length, sections };
  }

  const text = (input.contentText || "").replace(/\r\n/g, "\n").trim();
  if (!text) return { blocks: [], charCount: 0, sections: [] };
  return {
    blocks: blocksFromReadable(text),
    charCount: text.length,
    sections: [],
  };
}

function clampChar(value: number, charCount: number): number {
  if (charCount <= 0) return 0;
  if (!Number.isFinite(value)) return 0;
  return Math.min(charCount - 1, Math.max(0, Math.floor(value)));
}

function fraction(current: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  if (!Number.isFinite(current) || current <= 0) return 0;
  return Math.min(1, current / duration);
}

function sectionsHaveDurations(sections: TranscriptSection[]): boolean {
  return sections.length > 0 && sections.every((section) => (section.durationSeconds ?? 0) > 0);
}

function sectionsHaveClock(sections: TranscriptSection[]): boolean {
  return (
    sections.length > 0 &&
    sections.every(
      (section) =>
        typeof section.startSeconds === "number" &&
        Number.isFinite(section.startSeconds) &&
        (section.durationSeconds ?? 0) > 0
    )
  );
}

function orderedByStart(sections: TranscriptSection[]): TranscriptSection[] {
  return [...sections].sort(
    (a, b) => (a.startSeconds ?? 0) - (b.startSeconds ?? 0) || a.index - b.index
  );
}

/** Character index in the readable transcript for the current playback position. */
export function charIndexForPlayback(
  doc: ReadAlongDocument,
  position: ReadAlongPosition
): number {
  if (doc.charCount <= 0) return 0;

  if (position.mode === "stream") {
    return clampChar(position.streamCursor ?? 0, doc.charCount);
  }

  if (position.mode === "section" && position.sectionIndex != null) {
    const section = doc.sections.find((item) => item.index === position.sectionIndex);
    if (section) {
      // Per-section files play on their own clock: the element's duration is
      // the file, so the measured full-file clock must not be used here.
      return sectionCharAtSeconds(section, position.currentTime, position.duration);
    }
  }

  if (position.mode === "full" && sectionsHaveClock(doc.sections)) {
    const ordered = orderedByStart(doc.sections);
    const time = Math.max(0, position.currentTime || 0);
    let current = ordered[0]!;
    for (const section of ordered) {
      if ((section.startSeconds ?? 0) <= time + 0.001) current = section;
      else break;
    }
    const duration = current.durationSeconds ?? 0;
    return sectionCharAtSeconds(
      current,
      Math.max(0, time - (current.startSeconds ?? 0)),
      duration
    );
  }

  if (position.mode === "full" && sectionsHaveDurations(doc.sections)) {
    let elapsed = 0;
    const time = Math.max(0, position.currentTime || 0);
    for (const section of doc.sections) {
      const length = section.durationSeconds ?? 0;
      if (time < elapsed + length || section === doc.sections[doc.sections.length - 1]) {
        const into = Math.max(0, time - elapsed);
        return sectionCharAtSeconds(section, into, length);
      }
      elapsed += length;
    }
  }

  return clampChar(
    fraction(position.currentTime, position.duration) * doc.charCount,
    doc.charCount
  );
}

/** Seconds for a character in the transcript. Section clocks when every section has one. */
export function passageSeekForChar(
  doc: ReadAlongDocument,
  charIndex: number
): {
  /** Into the finished file. Null when only a fraction of an unknown duration is known. */
  fullSeconds: number | null;
  fraction: number;
  sectionIndex: number | null;
  /** Into that section's own file, when the section has a duration. */
  sectionSeconds: number | null;
} {
  const char = clampChar(charIndex, Math.max(doc.charCount, 1));
  const section =
    doc.sections.find(
      (item) => char >= item.charStart && char < item.charEnd
    ) ?? null;
  if (section && sectionsHaveClock(doc.sections)) {
    const duration = section.durationSeconds ?? 0;
    const sectionSeconds = sectionSecondsAtChar(section, char, duration);
    const total = orderedByStart(doc.sections).reduce(
      (end, item) => Math.max(end, (item.startSeconds ?? 0) + (item.durationSeconds ?? 0)),
      0
    );
    const fullSeconds = (section.startSeconds ?? 0) + sectionSeconds;
    return {
      fullSeconds,
      fraction: total > 0 ? Math.min(1, fullSeconds / total) : 0,
      sectionIndex: section.index,
      sectionSeconds,
    };
  }
  if (section && sectionsHaveDurations(doc.sections)) {
    let elapsed = 0;
    for (const item of doc.sections) {
      if (item.index === section.index) break;
      elapsed += item.durationSeconds ?? 0;
    }
    const length = section.durationSeconds ?? 0;
    const sectionSeconds = sectionSecondsAtChar(section, char, length);
    const total = doc.sections.reduce(
      (sum, item) => sum + (item.durationSeconds ?? 0),
      0
    );
    const fullSeconds = elapsed + sectionSeconds;
    return {
      fullSeconds,
      fraction: total > 0 ? Math.min(1, fullSeconds / total) : 0,
      sectionIndex: section.index,
      sectionSeconds,
    };
  }
  const frac =
    doc.charCount > 0 ? Math.min(1, Math.max(0, charIndex) / doc.charCount) : 0;
  return {
    fullSeconds: null,
    fraction: frac,
    sectionIndex: section?.index ?? null,
    sectionSeconds: null,
  };
}

/** Character where the sentence containing `offset` begins. */
export function sentenceStartInText(text: string, offset: number): number {
  const at = Math.min(text.length, Math.max(0, Math.floor(offset)));
  const re = /[.!?…]["”’)]*\s+/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const next = match.index + match[0].length;
    if (next > at) break;
    start = next;
  }
  return start;
}

export function activeBlockIndex(
  doc: ReadAlongDocument,
  position: ReadAlongPosition
): number {
  if (doc.blocks.length === 0) return -1;
  const char = charIndexForPlayback(doc, position);
  const index = doc.blocks.findIndex(
    (block) => char >= block.charStart && char < block.charEnd
  );
  if (index >= 0) return index;
  for (let i = doc.blocks.length - 1; i >= 0; i--) {
    if (doc.blocks[i]!.charStart <= char) return i;
  }
  return 0;
}
