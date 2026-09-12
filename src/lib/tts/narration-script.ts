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

/**
 * Whole-book Fish S2 free-form delivery cue (not spoken words).
 * Official S2 cues are square brackets with natural-language descriptions.
 * Live Listen / Live Stream omit this so the fast path stays light.
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

/**
 * Insert Fish S2 pause tags so Whole book can breathe.
 *
 * Headings and paragraph boundaries get `[long-break]`. Dense academic
 * sentences get `[break]`. Clean paragraph-broken prose only gets the
 * long pause between paragraphs.
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
    if (isSpeakableHeading(p)) {
      parts.push(`${p}\n${FISH_LONG_PAUSE}`);
      continue;
    }
    const body = punctuateDenseSentences(p, opts?.pauseStyle ?? "normal");
    if (i < paragraphs.length - 1) {
      parts.push(`${body}\n\n${FISH_LONG_PAUSE}`);
    } else {
      parts.push(body);
    }
  }

  return parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function deliveryPrefixEnabled(flag?: boolean): boolean {
  if (!flag) return false;
  const raw = process.env.TTS_WHOLE_BOOK_DELIVERY_PREFIX;
  if (raw === "0" || raw === "false") return false;
  return true;
}

function withWholeBookDeliveryPrefix(script: string): string {
  const trimmed = script.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith(FISH_WHOLE_BOOK_DELIVERY_PREFIX)) return trimmed;
  return `${FISH_WHOLE_BOOK_DELIVERY_PREFIX} ${trimmed}`;
}

export function narrationScriptForSynthesis(
  speakable: string,
  providerId: string,
  opts?: { deliveryPrefix?: boolean; pauseStyle?: "sparse" | "normal" }
): string {
  if (providerId !== "fish") return speakable;
  const script = toFishNarrationScript(speakable, {
    pauseStyle: opts?.pauseStyle,
  });
  if (deliveryPrefixEnabled(opts?.deliveryPrefix)) {
    return withWholeBookDeliveryPrefix(script);
  }
  return script;
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
