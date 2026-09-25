/**
 * Fish S2 narration script — pauses and phrasing, not slower vowels.
 *
 * Official S2 cues (https://docs.fish.audio/developer-guide/core-features/emotions):
 *   `[break]`       short pause
 *   `[long-break]`  extended pause
 *
 * S1 `(break)` / blog `[pause]` / SSML `<break>` are not used. `s2.1-pro-free`
 * reads the bracket tags. Edge / Google keep the same tags as an IR, then
 * `ssml-pauses.ts` maps them (Google → SSML `<break>`; Edge → text breaths,
 * because custom `<break>` is 1007). OpenRouter / Gemini /
 * Grok would speak the words, so they stay untagged.
 *
 * Fish receives the cleaned words with no square-bracket cues.
 * Edge / Google keep `[break]` / `[long-break]` as a pause IR.
 * Narration does not prepend `[conversational seminar tone]`.
 * `deliveryPrefix` is still accepted and ignored so stored jobs parse.
 */

import { isSpeakableHeading, isChapterHeading, splitSentences } from "@/lib/tts/speakable-text";
import {
  isAllowedFishS2Cue,
  stripAllSquareCues,
  stripNonPauseFishCues,
} from "@/lib/tts/fish-s2-cues";
import { isSceneBreakMarker } from "@/lib/tts/split-text";

export const FISH_SHORT_PAUSE = "[break]";
export const FISH_LONG_PAUSE = "[long-break]";
export const FISH_SOFT_TONE = "[soft tone]";
export const FISH_EMPHASIS = "[emphasis]";
/** Clear narration. Not the lullaby `[soft tone]` cue. */
export const FISH_CONFIDENT = "[confident]";

/**
 * Retired book-level invent-string. Narration no longer prepends it.
 * Register comes from line-level allowlisted cues on Whole-book Fish.
 * Kept so callers can still assert the cue is absent.
 */
export const FISH_WHOLE_BOOK_DELIVERY_CUE = "conversational seminar tone";
export const FISH_WHOLE_BOOK_DELIVERY_PREFIX = `[${FISH_WHOLE_BOOK_DELIVERY_CUE}]`;

/** Only sentences longer than this may get one mid-comma `[break]`. */
export const LONG_SENTENCE_COMMA_BREAK_CHARS = 220;

const MIN_CLAUSE_CHARS = 40;

const LONG_BREAK_RE = /\s*\[long-break\]\s*/gi;
const SHORT_BREAK_RE = /\s*\[break\]\s*/gi;

function stripFishPauseTags(text: string): string {
  return text
    .replace(LONG_BREAK_RE, "\n\n")
    .replace(SHORT_BREAK_RE, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * At most one breath inside a very long sentence, at a mid comma.
 * Never breaks after every `and` / `that` / comma.
 */
export function decideLongSentenceCommaBreak(
  sentence: string,
  minChars = LONG_SENTENCE_COMMA_BREAK_CHARS
): number | null {
  const t = sentence.trim();
  if (t.length <= minChars) return null;

  const candidates: number[] = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== ",") continue;
    if (/\d/.test(t[i - 1] || "") && /\d/.test(t[i + 1] || "")) continue;
    const left = t.slice(0, i).trim();
    const right = t.slice(i + 1).trim();
    if (left.length < MIN_CLAUSE_CHARS || right.length < MIN_CLAUSE_CHARS) {
      continue;
    }
    if (/^(and|that)\b/i.test(right)) continue;
    candidates.push(i);
  }
  if (!candidates.length) return null;
  const mid = Math.floor(t.length / 2);
  return candidates.reduce((best, i) =>
    Math.abs(i - mid) < Math.abs(best - mid) ? i : best
  );
}

function applyLongSentenceCommaBreak(sentence: string): string {
  const t = sentence.trim();
  if (/\[break\]/i.test(t)) return t;
  const at = decideLongSentenceCommaBreak(t);
  if (at == null) return t;
  return `${t.slice(0, at + 1)} ${FISH_SHORT_PAUSE} ${t.slice(at + 1).trim()}`;
}

function punctuateDenseSentences(
  para: string,
  pauseStyle: "sparse" | "normal" = "normal"
): string {
  if (pauseStyle === "sparse") return para;
  const sentences = splitSentences(para).map(applyLongSentenceCommaBreak);
  if (sentences.length <= 1) return sentences[0] || para;
  const avg = para.length / sentences.length;
  // Long academic sentences need a beat. Short dialogue does not.
  if (avg < 100) return sentences.join(" ");

  return sentences
    .map((sentence, i) => {
      const t = sentence.trim();
      if (i === sentences.length - 1) return t;
      if (/\[break\]\s*$/i.test(t)) return t;
      return `${t} ${FISH_SHORT_PAUSE}`;
    })
    .join(" ");
}

function withoutFishCues(text: string): string {
  return stripAllSquareCues(text).replace(/[^\S\n]+/g, " ").trim();
}

function isHeadingLine(plain: string): boolean {
  return isSpeakableHeading(plain) || isChapterHeading(plain);
}

function formatHeading(plain: string): string {
  return `${plain}\n${FISH_LONG_PAUSE}`;
}

/**
 * Insert Fish S2 pause tags so Whole book has beats between headings,
 * paragraphs, and long sentences. `[break]` / `[long-break]` are silence.
 * They are not breath effects.
 *
 * Headings and paragraph boundaries get `[long-break]`.
 * A scene-break line (`***` or `---`) is dropped, same as layout noise.
 * Dense academic sentences get `[break]`. Clean paragraph-broken prose
 * only gets the long pause between paragraphs.
 */
export function toFishNarrationScript(
  speakable: string,
  opts?: { pauseStyle?: "sparse" | "normal" }
): string {
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
    const plain = withoutFishCues(p);
    if (!plain || isSceneBreakMarker(plain)) continue;
    if (isHeadingLine(plain)) {
      parts.push(formatHeading(plain));
      continue;
    }
    const body = punctuateDenseSentences(p, opts?.pauseStyle ?? "normal");
    const more = paragraphs.slice(i + 1).some((next) => {
      const nextPlain = withoutFishCues(next);
      return nextPlain && !isSceneBreakMarker(nextPlain);
    });
    if (more) {
      parts.push(`${body}\n\n${FISH_LONG_PAUSE}`);
    } else {
      parts.push(body);
    }
  }

  return parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

const PAREN_EMOTION_RE = /\(\s*(sad|angry|excited|happy|whispering|sighing|slightly sad)\s*\)/gi;

function withHeadingPunctuation(line: string): string {
  const t = line.trim();
  if (!t || /[.!?…]["”’)]*$/.test(t)) return t;
  return `${t}.`;
}

/** Drop allowlisted Fish cues. Any other square brackets become parentheses. */
export function neutralizeFishBrackets(text: string): string {
  return (text ?? "")
    .replace(/\[([^\[\]]*)\]/g, (_full, inner: string) =>
      isAllowedFishS2Cue(inner) ? "" : `(${inner})`
    )
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/ +([.!?…])/g, "$1")
    .replace(/[^\S\n]{2,}/g, " ")
    .replace(/ +\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Fish S2 hears square brackets as direction. Whole book and previews
 * send the cleaned words only: headings on their own paragraph, with
 * ending punctuation, and no cue tags.
 */
export function toFishPlainNarration(speakable: string): string {
  const cleaned = (speakable ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!cleaned) return "";
  const paragraphs = cleaned
    .split(/\n\s*\n/)
    .map((p) => p.replace(/[^\S\n]+/g, " ").trim())
    .filter(Boolean);
  const parts: string[] = [];
  for (const paragraph of paragraphs) {
    const plain = withoutFishCues(paragraph);
    if (!plain || isSceneBreakMarker(plain)) continue;
    if (isHeadingLine(plain)) {
      parts.push(withHeadingPunctuation(paragraph));
      continue;
    }
    parts.push(paragraph);
  }
  return neutralizeFishBrackets(parts.join("\n\n"));
}

export function stripFishDeliveryCues(text: string): string {
  return stripNonPauseFishCues(text)
    .replace(PAREN_EMOTION_RE, " ")
    .replace(/[^\S\n]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const PAUSE_SCRIPT_PROVIDERS = new Set(["fish", "edge", "google"]);

/** Fish, Edge, and Google share the pause-tag IR. Others stay untagged. */
export function usesNarrationPauseScript(providerId: string): boolean {
  return PAUSE_SCRIPT_PROVIDERS.has(providerId);
}

export function narrationScriptForSynthesis(
  speakable: string,
  providerId: string,
  opts?: { deliveryPrefix?: boolean; pauseStyle?: "sparse" | "normal" }
): string {
  if (!usesNarrationPauseScript(providerId)) return speakable;
  if (providerId === "fish") return toFishPlainNarration(speakable);
  const source = stripFishDeliveryCues(speakable);
  return stripFishDeliveryCues(
    toFishNarrationScript(source, {
      pauseStyle: opts?.pauseStyle,
    })
  );
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
