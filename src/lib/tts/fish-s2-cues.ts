/**
 * Fish Speech S2 square-bracket cues.
 *
 * Source: https://docs.fish.audio/developer-guide/core-features/emotions
 *
 * S2 is square brackets. Whole-book Fish narration does not insert these
 * cues. The list is what we strip before synthesis, so a leftover tag is
 * not spoken as a word. Other square brackets in the book become
 * parentheses. S1 parentheses are not used as direction.
 */

/** Pauses. Never counted toward the performance-cue cap. */
export const FISH_S2_STRUCTURAL_CUES = ["break", "long-break"] as const;

export const FISH_S2_EMOTION_CUES = [
  "happy",
  "sad",
  "angry",
  "excited",
  "calm",
  "nervous",
  "confident",
  "surprised",
  "satisfied",
  "delighted",
  "scared",
  "worried",
  "upset",
  "frustrated",
  "depressed",
  "empathetic",
  "embarrassed",
  "disgusted",
  "moved",
  "proud",
  "relaxed",
  "grateful",
  "curious",
  "sarcastic",
  "disdainful",
  "unhappy",
  "anxious",
  "hysterical",
  "indifferent",
  "uncertain",
  "doubtful",
  "confused",
  "disappointed",
  "regretful",
  "guilty",
  "ashamed",
  "jealous",
  "envious",
  "hopeful",
  "optimistic",
  "pessimistic",
  "nostalgic",
  "lonely",
  "bored",
  "contemptuous",
  "sympathetic",
  "compassionate",
  "determined",
  "resigned",
] as const;

export const FISH_S2_TONE_CUES = [
  "in a hurry tone",
  "shouting",
  "screaming",
  "whispering",
  "soft tone",
  "emphasis",
] as const;

export const FISH_S2_EFFECT_CUES = [
  "laughing",
  "chuckling",
  "sobbing",
  "crying loudly",
  "sighing",
  "groaning",
  "panting",
  "gasping",
  "yawning",
  "snoring",
  "clear throat",
  "audience laughing",
  "background laughter",
  "crowd laughing",
] as const;

export const FISH_S2_ALLOWED_CUES: ReadonlySet<string> = new Set<string>([
  ...FISH_S2_STRUCTURAL_CUES,
  ...FISH_S2_EMOTION_CUES,
  ...FISH_S2_TONE_CUES,
  ...FISH_S2_EFFECT_CUES,
]);

const EMOTION_SET: ReadonlySet<string> = new Set(FISH_S2_EMOTION_CUES);
const INTENSITY_RE = /^(slightly|very|extremely)\s+(.+)$/;

const CUE_RE = /\[([^\[\]]+)\]/g;

function normalizeCueInner(inner: string): string {
  return inner.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Fish-accepted cue: a published pause, emotion, tone, or effect, or
 * slightly / very / extremely plus a listed emotion.
 */
export function isAllowedFishS2Cue(inner: string): boolean {
  const t = normalizeCueInner(inner);
  if (!t) return false;
  if (FISH_S2_ALLOWED_CUES.has(t)) return true;
  const intensity = INTENSITY_RE.exec(t);
  if (intensity && EMOTION_SET.has(intensity[2]!)) return true;
  return false;
}

export function stripAllSquareCues(text: string): string {
  return text.replace(CUE_RE, " ");
}

/** Drop every square-bracket cue, including ones Fish would reject. */
export function stripFishS2Cues(text: string): string {
  return text
    .replace(CUE_RE, " ")
    .replace(/[^\S\n]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Drop every square-bracket cue except `[break]` / `[long-break]`.
 * Edge / Google map those pause tags; emotion/tone tags would be spoken.
 */
export function stripNonPauseFishCues(text: string): string {
  return tidyTaggedWhitespace(
    (text || "").replace(CUE_RE, (full, inner: string) => {
      const t = normalizeCueInner(inner);
      if (t === "break" || t === "long-break") return full;
      return " ";
    })
  );
}

export function proseFingerprint(text: string): string {
  return stripAllSquareCues(text).replace(/\s+/g, " ").trim();
}

function tidyTaggedWhitespace(text: string): string {
  return text
    .replace(/[^\S\n]{2,}/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
