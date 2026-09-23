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
 */

import { isSpeakableHeading, isChapterHeading, splitSentences } from "@/lib/tts/speakable-text";
import { looksFictionLike } from "@/lib/tts/delivery-settings";
import { isAllowedFishS2Cue, stripNonPauseFishCues } from "@/lib/tts/fish-s2-cues";
import { isSceneBreakMarker } from "@/lib/tts/split-text";

export const FISH_SHORT_PAUSE = "[break]";
export const FISH_LONG_PAUSE = "[long-break]";
export const FISH_SOFT_TONE = "[soft tone]";
export const FISH_EMPHASIS = "[emphasis]";

/**
 * Whole-book Fish S2 free-form delivery cue (not spoken words).
 * Official S2 cues are square brackets with natural-language descriptions.
 * Live Listen / Live Stream honor the same resolved `deliveryPrefix` flag.
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
  return text
    .replace(/\[[^\[\]]+\]/g, (full) => {
      const inner = full.slice(1, -1);
      return isAllowedFishS2Cue(inner) ? " " : full;
    })
    .replace(/[^\S\n]+/g, " ")
    .trim();
}

function isHeadingLine(plain: string, fishCues: boolean): boolean {
  if (isSpeakableHeading(plain)) return true;
  return fishCues && isChapterHeading(plain);
}

/**
 * Fish-only heading delivery. Soft tone on the title, then the existing
 * long break. A short title also gets `[emphasis]` before the words.
 */
function formatHeading(plain: string, fishCues: boolean): string {
  if (!fishCues) return `${plain}\n${FISH_LONG_PAUSE}`;
  const words = plain.split(/\s+/).filter(Boolean);
  const shortTitle = words.length > 0 && words.length <= 6 && plain.length <= 48;
  const cues = shortTitle ? `${FISH_SOFT_TONE} ${FISH_EMPHASIS}` : FISH_SOFT_TONE;
  return `${cues} ${plain}\n${FISH_LONG_PAUSE}`;
}

/**
 * Insert Fish S2 pause tags so Whole book can breathe.
 *
 * Headings and paragraph boundaries get `[long-break]`. With `fishCues`,
 * headings (including Foreword / Coda) are spoken in `[soft tone]`.
 * A scene-break line (`***` or `---`) is dropped, same as layout noise.
 * Dense academic sentences get `[break]`. Clean paragraph-broken prose
 * only gets the long pause between paragraphs.
 */
export function toFishNarrationScript(
  speakable: string,
  opts?: { pauseStyle?: "sparse" | "normal"; fishCues?: boolean }
): string {
  const cleaned = stripFishPauseTags(
    speakable.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  );
  if (!cleaned) return "";

  const paragraphs = cleaned
    .split(/\n\s*\n/)
    .map((p) => p.replace(/[^\S\n]+/g, " ").trim())
    .filter(Boolean);

  const fishCues = opts?.fishCues === true;
  const parts: string[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i]!;
    const plain = withoutFishCues(p);
    if (!plain || isSceneBreakMarker(plain)) continue;
    if (isHeadingLine(plain, fishCues)) {
      parts.push(formatHeading(plain, fishCues));
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

const PAREN_EMOTION_RE = /\(\s*(sad|angry|excited|happy|whispering|sighing|slightly sad)\s*\)/gi;

const EMOTION_RULES: { re: RegExp; tag: string }[] = [
  { re: /\b(whispered|whispering|softly|in a whisper)\b/i, tag: "[whispering]" },
  { re: /\b(sighed|sighing)\b/i, tag: "[sighing]" },
  { re: /\b(wept|crying|tearfully|mournful)\b/i, tag: "[slightly sad]" },
  { re: /(?:^|[.!?]\s+)[^.!?]{0,80}!\s*$/ , tag: "[excited]" },
];

const MAX_EMOTION_TAGS_PER_SECTION = 4;

export function rewriteParenEmotionsToBrackets(text: string): string {
  return text.replace(PAREN_EMOTION_RE, (_, inner: string) => `[${inner.trim().toLowerCase()}]`);
}

export function applyLightFishEmotions(text: string): string {
  let used = 0;
  return text
    .split(/\n\s*\n/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return "";
      if (/\[(?:long-break|soft tone|emphasis)\]/i.test(trimmed)) {
        return trimmed;
      }
      const sentences = splitSentences(trimmed);
      if (sentences.length === 0) return trimmed;
      return sentences
        .map((sentence) => {
          if (used >= MAX_EMOTION_TAGS_PER_SECTION) return sentence;
          if (
            /\[(?:whispering|sighing|excited|sad|slightly sad|angry|happy|surprised|nervous|calm)\]/i.test(
              sentence
            )
          ) {
            return sentence;
          }
          for (const rule of EMOTION_RULES) {
            if (!rule.re.test(sentence)) continue;
            used += 1;
            return `${rule.tag} ${sentence.trim()}`;
          }
          return sentence;
        })
        .join(" ");
    })
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
  let source = speakable;
  if (providerId === "fish") {
    source = rewriteParenEmotionsToBrackets(source);
  } else {
    source = stripFishDeliveryCues(source);
  }
  let script = toFishNarrationScript(source, {
    pauseStyle: opts?.pauseStyle,
    fishCues: providerId === "fish",
  });
  if (providerId === "fish") {
    script = applyLightFishEmotions(script);
    const fiction = looksFictionLike(speakable);
    if (deliveryPrefixEnabled(opts?.deliveryPrefix) && !fiction) {
      script = withWholeBookDeliveryPrefix(script);
    }
    return script;
  }
  return stripFishDeliveryCues(script);
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
