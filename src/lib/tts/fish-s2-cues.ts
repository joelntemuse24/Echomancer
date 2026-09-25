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
  return (text ?? "").replace(CUE_RE, "").replace(/\s+/g, " ").trim();
}

/** Put a space around a cue so Fish does not read it glued to the next word. */
export function spaceFishCueTags(text: string): string {
  const moved = (text ?? "").replace(
    /([“"‘'])(\[[^\[\]\n]+\])/g,
    "$2 $1"
  );
  return moved.replace(/(\[[^\[\]\n]+\])(?=[^\s\[])/g, "$1 ");
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
  const cleaned = spaceFishCueTags(
    tidyTaggedWhitespace(
      capNonPauseCues(
        dropUnknownCues(candidate),
        maxFishS2PerformanceCuesForText(source)
      )
    )
  );
  if (proseFingerprint(cleaned) !== proseFingerprint(source)) {
    return source;
  }
  return cleaned || source;
}

/**
 * Steady delivery next to Edge: clear speech, not a shout and not the
 * breathy `[calm]` / `[soft tone]` register. Heat the sentence does not
 * warrant is mapped onto these official cues.
 */
export const FISH_CALM_DELIVERY_CUES = [
  "confident",
  "emphasis",
  "curious",
  "indifferent",
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

const EFFECT_CUE_SET: ReadonlySet<string> = new Set(FISH_S2_EFFECT_CUES);

/**
 * Cues that make s2.1-pro-free inhale, sigh, or whisper on ordinary narration.
 * `[soft tone]` is the lullaby cue and is always removed. Effects and
 * `[whispering]` stay only when the same sentence depicts that sound.
 * Dense `[calm]` is handled separately: it is a breath register on
 * exposition, not an effect.
 */
export function isBreathProneFishCue(inner: string): boolean {
  const t = normalizeCueInner(inner);
  if (t === "soft tone" || t === "whispering") return true;
  return EFFECT_CUE_SET.has(t);
}

function cueBase(inner: string): string {
  const t = normalizeCueInner(inner);
  const intensity = INTENSITY_RE.exec(t);
  return intensity?.[2] ?? t;
}

function isCalmDeliveryCue(inner: string): boolean {
  return cueBase(inner) === "calm";
}

/**
 * Lexical calm. A default `[calm]` on exposition is the breath register
 * heard on nonfiction; the word has to be in the sentence.
 */
const CALM_WARRANT_RE =
  /\b(?:calm(?:ly|ness)?|sooth(?:e|ed|es|ing)|peaceful(?:ly)?|serene(?:ly)?|reassur(?:e|ed|es|ing)|lullaby|lulling)\b/i;

function sentenceStartIndex(text: string, index: number): number {
  for (let i = index - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "\n" || ch === "." || ch === "!" || ch === "?") {
      return i + 1;
    }
  }
  return 0;
}

const BREATH_WARRANTS: { cues: ReadonlySet<string>; re: RegExp }[] = [
  {
    cues: new Set(["whispering"]),
    re: /\b(?:whisper(?:ed|ing|s)?|in a whisper)\b/i,
  },
  {
    cues: new Set(["sighing"]),
    re: /\b(?:sighed|sighs|let out a sigh|with a sigh|gave a sigh|heaved a sigh)\b/i,
  },
  { cues: new Set(["gasping"]), re: /\bgasp(?:ed|ing|s)?\b/i },
  {
    cues: new Set(["panting"]),
    re: /\b(?:pant(?:ed|ing|s)?|huff(?:ed|ing)?|puff(?:ed|ing)?)\b/i,
  },
  { cues: new Set(["groaning"]), re: /\bgroan(?:ed|ing|s)?\b/i },
  { cues: new Set(["yawning"]), re: /\byawn(?:ed|ing|s)?\b/i },
  { cues: new Set(["snoring"]), re: /\bsnor(?:e|ed|es|ing)\b/i },
  {
    cues: new Set(["sobbing", "crying loudly"]),
    re: /\b(?:sob(?:bed|bing|s)?|cry(?:ing)?|cried|wept|weep(?:ing)?|tearfully)\b/i,
  },
  {
    cues: new Set([
      "laughing",
      "chuckling",
      "audience laughing",
      "background laughter",
      "crowd laughing",
    ]),
    re: /\b(?:laugh(?:ed|ing|s|ter)?|chuckl(?:e|ed|ing)|giggl(?:e|ed|ing))\b/i,
  },
  {
    cues: new Set(["clear throat"]),
    re: /\b(?:ahem|clears?(?:ed|ing)? (?:his|her|their|the) throat)\b/i,
  },
];

function breathWarrant(cue: string): RegExp | null {
  for (const row of BREATH_WARRANTS) {
    if (row.cues.has(cue)) return row.re;
  }
  return null;
}

function sentenceDepicts(text: string, index: number, re: RegExp): boolean {
  const prose = sentenceWindow(text, index).replace(/\[[^\[\]]+\]/g, " ");
  return re.test(prose);
}

/**
 * Keep narration from breathing at random.
 * `[soft tone]` is removed and is not rewritten into `[calm]`.
 * `[calm]` (including slightly / very / extremely) stays only when the
 * same sentence depicts a calm or soothing delivery and no other kept
 * cue is already on that sentence. A stack such as `[calm][emphasis]`
 * on exposition drops the calm. Whisper and effect cues stay only when
 * the same sentence depicts that sound. Shouts and other emotions stay.
 * `[break]` and `[long-break]` are silence in the shared pause IR and
 * are not treated as breaths.
 */
export function restrainBreathFishCues(text: string): string {
  const source = text ?? "";
  if (!source) return source;
  const cueRe = new RegExp(CUE_RE.source, "g");
  const hits: { index: number; inner: string }[] = [];
  for (const match of source.matchAll(cueRe)) {
    hits.push({ index: match.index ?? 0, inner: match[1] ?? "" });
  }
  if (!hits.length) return source;

  const bySentence = new Map<number, { index: number; inner: string }[]>();
  for (const hit of hits) {
    const start = sentenceStartIndex(source, hit.index);
    const list = bySentence.get(start);
    if (list) list.push(hit);
    else bySentence.set(start, [hit]);
  }

  const drop = new Set<number>();
  for (const group of bySentence.values()) {
    const keptNonCalm = group.some((hit) => {
      if (isPauseCue(hit.inner)) return false;
      if (normalizeCueInner(hit.inner) === "soft tone") return false;
      if (isCalmDeliveryCue(hit.inner)) return false;
      if (!isBreathProneFishCue(hit.inner)) return true;
      const warrant = breathWarrant(normalizeCueInner(hit.inner));
      return Boolean(warrant && sentenceDepicts(source, hit.index, warrant));
    });
    let keptCalm = false;
    for (const hit of group) {
      const cue = normalizeCueInner(hit.inner);
      if (cue === "soft tone") {
        drop.add(hit.index);
        continue;
      }
      if (isCalmDeliveryCue(hit.inner)) {
        const warranted =
          !keptNonCalm &&
          !keptCalm &&
          sentenceDepicts(source, hit.index, CALM_WARRANT_RE);
        if (!warranted) drop.add(hit.index);
        else keptCalm = true;
        continue;
      }
      if (!isBreathProneFishCue(hit.inner)) continue;
      const warrant = breathWarrant(cue);
      if (!(warrant && sentenceDepicts(source, hit.index, warrant))) {
        drop.add(hit.index);
      }
    }
  }

  if (drop.size === 0) return source;
  const replaced = source.replace(
    new RegExp(CUE_RE.source, "g"),
    (full, _inner: string, offset: number) => (drop.has(offset) ? "" : full)
  );
  return tidyTaggedWhitespace(replaced);
}
