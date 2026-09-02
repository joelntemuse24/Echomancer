/**
 * Fish S2 narration script — pauses and phrasing, not slower vowels.
 *
 * Official S2 cues (https://docs.fish.audio/developer-guide/core-features/emotions):
 *   `[break]`       short pause
 *   `[long-break]`  extended pause
 *
 * S1 `(break)` / blog `[pause]` / SSML `<break>` are not used. `s2.1-pro-free`
 * reads the bracket tags. Other providers would speak the words, so tags are
 * applied only on the Fish adapter.
 */

import { isSpeakableHeading, splitSentences } from "@/lib/tts/speakable-text";

export const FISH_SHORT_PAUSE = "[break]";
export const FISH_LONG_PAUSE = "[long-break]";

const LONG_BREAK_RE = /\s*\[long-break\]\s*/gi;
const SHORT_BREAK_RE = /\s*\[break\]\s*/gi;

function stripFishPauseTags(text: string): string {
  return text
    .replace(LONG_BREAK_RE, "\n\n")
    .replace(SHORT_BREAK_RE, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function punctuateDenseSentences(para: string): string {
  const sentences = splitSentences(para);
  if (sentences.length <= 1) return para;
  const avg = para.length / sentences.length;
  // Long academic sentences need a beat. Short dialogue does not.
  if (avg < 100) return para;

  return sentences
    .map((sentence, i) => {
      const t = sentence.trim();
      if (i === sentences.length - 1) return t;
      if (/\[break\]\s*$/i.test(t)) return t;
      return `${t} ${FISH_SHORT_PAUSE}`;
    })
    .join(" ");
}

/**
 * Insert Fish S2 pause tags so Whole book can breathe.
 *
 * Headings and paragraph boundaries get `[long-break]`. Dense academic
 * sentences get `[break]`. Clean paragraph-broken prose only gets the
 * long pause between paragraphs.
 */
export function toFishNarrationScript(speakable: string): string {
  const cleaned = stripFishPauseTags(
    speakable.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  );
  if (!cleaned) return "";

  const paragraphs = cleaned
    .split(/\n\s*\n/)
    .map((p) => p.replace(/[^\S\n]+/g, " ").trim())
    .filter(Boolean);

  const parts: string[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i]!;
    if (isSpeakableHeading(p)) {
      parts.push(`${p}\n${FISH_LONG_PAUSE}`);
      continue;
    }
    const body = punctuateDenseSentences(p);
    if (i < paragraphs.length - 1) {
      parts.push(`${body}\n\n${FISH_LONG_PAUSE}`);
    } else {
      parts.push(body);
    }
  }

  return parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function narrationScriptForSynthesis(
  speakable: string,
  providerId: string
): string {
  if (providerId === "fish") return toFishNarrationScript(speakable);
  return speakable;
}

/** Pause-opportunity score. Prefer this over raw WPM for "does it feel rushed?" */
export function scriptPauseScore(text: string): {
  paragraphBreaks: number;
  longBreakTags: number;
  shortBreakTags: number;
  pausePunctuation: number;
  charsPerParagraph: number;
} {
  const src = text || "";
  const paragraphs = src.split(/\n\s*\n/).filter((p) => p.trim());
  const paragraphBreaks = Math.max(0, paragraphs.length - 1);
  const longBreakTags = (src.match(/\[long-break\]/gi) || []).length;
  const shortBreakTags = (src.match(/\[break\]/gi) || []).length;
  const pausePunctuation = (src.match(/[.?!;:]/g) || []).length;
  const chars = src.replace(/\s+/g, " ").trim().length;
  return {
    paragraphBreaks,
    longBreakTags,
    shortBreakTags,
    pausePunctuation,
    charsPerParagraph: paragraphs.length
      ? chars / paragraphs.length
      : chars,
  };
}
