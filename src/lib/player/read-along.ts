/**
 * Read-along transcript from text the job already has.
 *
 * Cue tags are display-only noise. Timing uses section durations when every
 * section has one, otherwise a time-proportional walk of the same text.
 * Nothing here synthesizes or retags.
 */

import { stripFishS2Cues } from "@/lib/tts/fish-s2-cues";
import { isChapterHeading, isSpeakableHeading } from "@/lib/tts/speakable-text";

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

export interface TranscriptSection {
  index: number;
  charStart: number;
  charEnd: number;
  durationSeconds: number | null;
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

/**
 * Prefer the frozen speakable (what was actually narrated). Fall back to the
 * extracted book when the freeze has not been written yet.
 */
export function buildReadAlongDocument(input: {
  contentText?: string | null;
  frozenSections?: FrozenTranscriptSection[] | null;
}): ReadAlongDocument {
  const frozen = (input.frozenSections || []).filter(
    (section) => section.text.trim().length > 0
  );
  if (frozen.length > 0) {
    const parts: string[] = [];
    const sections: TranscriptSection[] = [];
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
      const duration = section.durationSeconds;
      sections.push({
        index: section.index,
        charStart,
        charEnd: cursor,
        durationSeconds:
          typeof duration === "number" && duration > 0 ? duration : null,
      });
    }
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

function charInSection(section: TranscriptSection, localFraction: number): number {
  const span = Math.max(1, section.charEnd - section.charStart);
  return section.charStart + Math.min(span - 1, Math.floor(localFraction * span));
}

function sectionsHaveDurations(sections: TranscriptSection[]): boolean {
  return sections.length > 0 && sections.every((section) => (section.durationSeconds ?? 0) > 0);
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
      return charInSection(section, fraction(position.currentTime, position.duration));
    }
  }

  if (position.mode === "full" && sectionsHaveDurations(doc.sections)) {
    let elapsed = 0;
    const time = Math.max(0, position.currentTime || 0);
    for (const section of doc.sections) {
      const length = section.durationSeconds ?? 0;
      if (time < elapsed + length || section === doc.sections[doc.sections.length - 1]) {
        const into = Math.max(0, time - elapsed);
        return charInSection(section, length > 0 ? Math.min(1, into / length) : 0);
      }
      elapsed += length;
    }
  }

  return clampChar(
    fraction(position.currentTime, position.duration) * doc.charCount,
    doc.charCount
  );
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
