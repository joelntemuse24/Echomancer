/**
 * Fish Speech S2 square-bracket cues.
 *
 * Source: https://docs.fish.audio/developer-guide/core-features/emotions
 *
 * S2 is square brackets. The tagger may use only this published emotion,
 * tone, effect, and pause set (plus slightly / very / extremely on a listed
 * emotion). `sanitizeFishS2TaggedText` strips every other bracket, rejects a
 * prose rewrite, and applies a length-scaled safety cap. `[break]` and
 * `[long-break]` do not count toward the cap. S1 parentheses are not used.
 *
 * Safety valve: at most one non-pause cue per
 * {@link FISH_S2_PERFORMANCE_CUE_EVERY_CHARS} prose characters (about two
 * cues on a typical sentence), and never more than
 * {@link MAX_FISH_S2_PERFORMANCE_CUES} on one speakable. That absolute
 * ceiling is reached only past ~480k characters. It replaces the old sparse
 * clamp (10 non-pause cues per ~8k characters, 240 per book).
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

/**
 * One non-pause cue per this many prose characters.
 * A typical ~80-character sentence can keep about two layered cues.
 */
export const FISH_S2_PERFORMANCE_CUE_EVERY_CHARS = 40;

/**
 * Absolute ceiling for one speakable. The linear budget reaches this only
 * past ~480k prose characters. It is a runaway-echo guard, not a sparsity cap.
 */
export const MAX_FISH_S2_PERFORMANCE_CUES = 12_000;

export function maxFishS2PerformanceCuesForText(text: string): number {
  const chars = Math.max(1, proseFingerprint(text).length);
  const scaled = Math.max(
    1,
    Math.ceil(chars / FISH_S2_PERFORMANCE_CUE_EVERY_CHARS)
  );
  return Math.min(MAX_FISH_S2_PERFORMANCE_CUES, scaled);
}

const CUE_RE = /\[([^\[\]]+)\]/g;

function normalizeCueInner(inner: string): string {
  return inner.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Fish-accepted cue: a published pause, emotion, tone, or effect, or
 * slightly / very / extremely plus a listed emotion. The sanitizer drops
 * every other bracket.
 */
export function isAllowedFishS2Cue(inner: string): boolean {
  const t = normalizeCueInner(inner);
  if (!t) return false;
  if (FISH_S2_ALLOWED_CUES.has(t)) return true;
  const intensity = INTENSITY_RE.exec(t);
  if (intensity && EMOTION_SET.has(intensity[2]!)) return true;
  return false;
}

function isPauseCue(inner: string): boolean {
  const t = normalizeCueInner(inner);
  return t === "break" || t === "long-break";
}

/** Drop every bracket Fish S2 does not accept. */
function dropUnknownCues(text: string): string {
  return text.replace(CUE_RE, (full, inner: string) =>
    isAllowedFishS2Cue(inner) ? full : ""
  );
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

/**
 * Keep the earliest allowlisted non-pause cues up to `max`.
 * Callers pass text that already went through {@link dropUnknownCues}.
 */
function capNonPauseCues(text: string, max: number): string {
  let used = 0;
  return text.replace(CUE_RE, (full, inner: string) => {
    if (isPauseCue(inner)) return full;
    used += 1;
    if (used > max) return "";
    return full;
  });
}

export function unwrapTaggedModelOutput(raw: string): string {
  let t = raw.trim();
  const fenced = t.match(/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/);
  if (fenced?.[1]) t = fenced[1].trim();
  t = t.replace(/^tagged text:\s*/i, "");
  return t.trim();
}

/**
 * Keep only Fish-accepted cues. Unknown brackets are stripped. If the model
 * rewrote the prose, return `original` unchanged. Pauses are uncapped; other
 * cues follow {@link maxFishS2PerformanceCuesForText}.
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
    capNonPauseCues(
      dropUnknownCues(candidate),
      maxFishS2PerformanceCuesForText(source)
    )
  );
  if (proseFingerprint(cleaned) !== proseFingerprint(source)) {
    return source;
  }
  return cleaned || source;
}

/**
 * Delivery that should feel alive next to Edge without a shout.
 * All four are official Fish S2 cues.
 */
export const FISH_CALM_DELIVERY_CUES = [
  "calm",
  "soft tone",
  "emphasis",
  "curious",
] as const;

export type FishCueHeatMode = "narration" | "expressive";

const HOT_BASE_CUES = new Set(["shouting", "screaming", "hysterical"]);

/**
 * Cues that make s2.1-pro-free shout or go theatrical.
 * Plain `[excited]` and `[angry]` stay; `very` / `extremely excited` and
 * `[extremely angry]` do not.
 */
export function isHotFishDeliveryCue(inner: string): boolean {
  const t = normalizeCueInner(inner);
  if (HOT_BASE_CUES.has(t)) return true;
  const intensity = INTENSITY_RE.exec(t);
  if (!intensity) return false;
  const level = intensity[1]!;
  const emotion = intensity[2]!;
  if (emotion === "hysterical") return true;
  if (emotion === "excited" && (level === "very" || level === "extremely")) {
    return true;
  }
  if (emotion === "angry" && level === "extremely") return true;
  return false;
}

const HEAT_WARRANT_RE =
  /\b(shout(?:ed|ing|s)?|scream(?:ed|ing|s)?|yell(?:ed|ing|s)?|shriek(?:ed|ing|s)?|bellow(?:ed|ing|s)?|hysterics|hysterical)\b/i;

function sentenceWindow(text: string, index: number): string {
  let start = 0;
  for (let i = index - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "\n" || ch === "." || ch === "!" || ch === "?") {
      start = i + 1;
      break;
    }
  }
  let end = text.length;
  for (let i = index; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n" || ch === "." || ch === "!" || ch === "?") {
      end = i + 1;
      break;
    }
  }
  return text.slice(start, end);
}

function sentenceWarrantsHeat(text: string, index: number): boolean {
  const prose = sentenceWindow(text, index).replace(/\[[^\[\]]+\]/g, " ");
  return HEAT_WARRANT_RE.test(prose);
}

/**
 * Swap hot Fish cues for calm delivery.
 * Narration mode keeps a shout only when the same sentence clearly
 * shouts, screams, or is hysterical. Expressive mode always remaps,
 * including that dialogue, so stock twins do not shout.
 */
export function restrainHotFishCues(
  text: string,
  mode: FishCueHeatMode = "narration"
): string {
  const source = text ?? "";
  if (!source) return source;
  let replaced = 0;
  return source.replace(CUE_RE, (full, inner: string, offset: number) => {
    if (!isHotFishDeliveryCue(inner)) return full;
    if (mode === "narration" && sentenceWarrantsHeat(source, offset)) {
      return full;
    }
    const cue =
      FISH_CALM_DELIVERY_CUES[replaced % FISH_CALM_DELIVERY_CUES.length]!;
    replaced += 1;
    return `[${cue}]`;
  });
}
