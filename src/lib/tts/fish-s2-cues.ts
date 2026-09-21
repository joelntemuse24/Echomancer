/**
 * Official Fish S2 square-bracket cues.
 *
 * Source: https://docs.fish.audio/developer-guide/core-features/emotions
 *
 * S2 is square brackets. S1 parentheses are not used. Free-form celebrity /
 * “sound like X” descriptions are rejected — Whole book only keeps this
 * allowlist (plus slightly/very/extremely + a listed emotion).
 */

/** Pauses and the Whole-book seminar prefix — never counted toward the emotion cap. */
export const FISH_S2_STRUCTURAL_CUES = [
  "break",
  "long-break",
  "conversational seminar tone",
] as const;

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
const STRUCTURAL_SET: ReadonlySet<string> = new Set(FISH_S2_STRUCTURAL_CUES);
const INTENSITY_RE = /^(slightly|very|extremely)\s+(.+)$/;

export const MAX_FISH_S2_EMOTION_TAGS_PER_SECTION = 6;

/** Sparse density: 6 tags per ~8k Fish target chars, capped for huge books. */
const FISH_EMOTION_CAP_CHUNK_CHARS = 8000;
const MAX_FISH_S2_EMOTION_TAGS_PER_BOOK = 240;

export function maxFishS2EmotionTagsForText(text: string): number {
  const chars = Math.max(1, proseFingerprint(text).length);
  const chunks = Math.max(
    1,
    Math.ceil(chars / FISH_EMOTION_CAP_CHUNK_CHARS)
  );
  return Math.min(
    MAX_FISH_S2_EMOTION_TAGS_PER_BOOK,
    chunks * MAX_FISH_S2_EMOTION_TAGS_PER_SECTION
  );
}

const CUE_RE = /\[([^\[\]]+)\]/g;

function normalizeCueInner(inner: string): string {
  return inner.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isAllowedFishS2Cue(inner: string): boolean {
  const t = normalizeCueInner(inner);
  if (!t) return false;
  if (FISH_S2_ALLOWED_CUES.has(t)) return true;
  const intensity = INTENSITY_RE.exec(t);
  if (intensity && EMOTION_SET.has(intensity[2]!)) return true;
  return false;
}

function isStructuralCue(inner: string): boolean {
  return STRUCTURAL_SET.has(normalizeCueInner(inner));
}

export function stripAllSquareCues(text: string): string {
  return text.replace(CUE_RE, " ");
}

export function stripFishS2Cues(text: string): string {
  return text
    .replace(CUE_RE, (full, inner: string) =>
      isAllowedFishS2Cue(inner) ? " " : full
    )
    .replace(/[^\S\n]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

function capEmotionTags(text: string, max: number): string {
  let used = 0;
  return text.replace(CUE_RE, (full, inner: string) => {
    if (!isAllowedFishS2Cue(inner)) return "";
    if (isStructuralCue(inner)) return full;
    used += 1;
    if (used > max) return "";
    return full;
  });
}

function dropUnknownCues(text: string): string {
  return text.replace(CUE_RE, (full, inner: string) =>
    isAllowedFishS2Cue(inner) ? full : ""
  );
}

export function unwrapTaggedModelOutput(raw: string): string {
  let t = raw.trim();
  const fenced = t.match(/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/);
  if (fenced?.[1]) t = fenced[1].trim();
  t = t.replace(/^tagged text:\s*/i, "");
  return t.trim();
}

/**
 * Keep only official Fish S2 cues. If the model rewrote the prose, return
 * `original` unchanged.
 */
export function sanitizeFishS2TaggedText(
  original: string,
  tagged: string
): string {
  const source = original ?? "";
  const candidate = unwrapTaggedModelOutput(tagged ?? "");
  if (!source.trim()) return source;
  if (!candidate.trim()) return source;
  if (proseFingerprint(candidate) !== proseFingerprint(source)) {
    return source;
  }
  const cleaned = tidyTaggedWhitespace(
    capEmotionTags(dropUnknownCues(candidate), maxFishS2EmotionTagsForText(source))
  );
  if (proseFingerprint(cleaned) !== proseFingerprint(source)) {
    return source;
  }
  return cleaned || source;
}
