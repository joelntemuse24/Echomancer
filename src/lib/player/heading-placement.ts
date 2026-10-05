/**
 * Where a heading is spoken inside one section.
 *
 * Character fraction of the raw window lands late: stripped links and cue
 * tags count as speech, and the match can sit inside the heading paragraph
 * instead of at its start. Speakable characters exclude those, paragraph
 * breaks the synth turns into silence are timed. A heading near the start of
 * its paragraph snaps to that start. A topic phrase deeper in a long
 * paragraph keeps its own offset.
 */

import { FISH_S2_TONE_CUES, stripAllSquareCues } from "@/lib/tts/fish-s2-cues";
import { stripUnspeakableTokens } from "@/lib/tts/speakable-text";
import { SSML_LONG_BREAK_MS, SSML_SHORT_BREAK_MS } from "@/lib/tts/ssml-pauses";

/** A tone cue is not spoken. Edge and Fish spend a short breath on it. */
export const SOFT_TONE_PAUSE_SEC = 0.4;

/** A heading this close to its paragraph start snaps to it. */
export const HEADING_SNAP_CHARS = 40;

const TONE_CUES = new Set<string>(FISH_S2_TONE_CUES);
const CUE_RE = /\[([^\[\]]+)\]/g;
const PARAGRAPH_RE = /\n[ \t]*\n/g;

export function headingParagraphStart(text: string, offset: number): number {
  const at = Math.max(0, Math.min(text.length, Math.floor(offset)));
  if (at <= 0) return 0;
  const head = text.slice(0, at);
  const breaks = /\n[ \t]*\n/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = breaks.exec(head))) {
    start = match.index + match[0].length;
  }
  while (start < at && (text[start] === " " || text[start] === "\t")) start += 1;
  return start;
}

function spokenChars(text: string): number {
  return stripUnspeakableTokens(stripAllSquareCues(text)).replace(/\s+/g, " ").trim().length;
}

function cuePauseSeconds(text: string, countBreakTags: boolean): number {
  let sec = 0;
  CUE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CUE_RE.exec(text))) {
    const inner = match[1]!.trim().toLowerCase().replace(/\s+/g, " ");
    if (inner === "long-break") {
      if (countBreakTags) sec += SSML_LONG_BREAK_MS / 1000;
    } else if (inner === "break") {
      if (countBreakTags) sec += SSML_SHORT_BREAK_MS / 1000;
    } else if (TONE_CUES.has(inner)) {
      sec += SOFT_TONE_PAUSE_SEC;
    }
  }
  if (!countBreakTags) {
    const breaks = text.match(PARAGRAPH_RE);
    sec += (breaks?.length ?? 0) * (SSML_LONG_BREAK_MS / 1000);
  }
  return sec;
}

/**
 * Seconds from the section start to the spoken heading.
 * `headingOffset` is an index into `sectionText`.
 */
export function headingOffsetSeconds(
  sectionText: string,
  headingOffset: number,
  sectionDuration: number
): number {
  if (!(sectionDuration > 0) || !sectionText) return 0;
  const at = Math.max(0, Math.min(sectionText.length, Math.floor(headingOffset)));
  const paragraph = headingParagraphStart(sectionText, at);
  const placed = at - paragraph <= HEADING_SNAP_CHARS ? paragraph : at;
  if (placed <= 0) return 0;
  const prefix = sectionText.slice(0, placed);
  const countBreakTags = /\[(?:long-)?break\]/i.test(sectionText);
  const pauseBefore = cuePauseSeconds(prefix, countBreakTags);
  const pauseAll = cuePauseSeconds(sectionText, countBreakTags);
  const charsBefore = spokenChars(prefix);
  const charsAll = spokenChars(sectionText);
  const pauseBudget = Math.min(pauseAll, sectionDuration * 0.5);
  const pauseScale = pauseAll > 0 ? pauseBudget / pauseAll : 0;
  const speech = sectionDuration - pauseBudget;
  const through = charsAll > 0 ? (charsBefore / charsAll) * speech : 0;
  return Math.min(sectionDuration, Math.max(0, pauseBefore * pauseScale + through));
}
