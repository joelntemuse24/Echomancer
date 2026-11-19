/**
 * Server-side Fish S2 performance tags. Off unless `FISH_S2_PERFORMANCE`
 * is `1`, `true`, or `on`.
 *
 * S2 reads square brackets as ordinary text. `TextPart` in upstream
 * `fish_speech/content_sequence.py` does not parse them; the model learned
 * the mapping. The published list is
 * https://docs.fish.audio/developer-guide/core-features/emotions
 * and the sampling defaults (temperature 0.7, top_p 0.7) live on
 * `generate_long` in `fish_speech/models/text2semantic/inference.py`.
 * Free-form tags work, and an unknown tag can be spoken as a word, so
 * this module only emits the cues in `fish-s2-cues.ts`.
 *
 * Previous-section continuity is decided here, from the previous
 * section's words. It is not a prompt of generated audio codes.
 * `history_anchor` in `modal/s2_contract.py` keeps a row's first unit
 * because chaining generated codes walked the timbre off the reference
 * (job 12534aaa). A text prompt with no matching audio is how a clone
 * goes degenerate, and a longer prefill would hold first audio.
 * The hosted API already conditions the chunks of one request
 * (`condition_on_previous_chunks`, default true). Hosted temperature
 * stays at the API default unless `FISH_S2_HOSTED_SAMPLING` is on.
 * 0.9/0.9 is not part of this flag: it changes clone variance even
 * when no tag is inserted, and the self-hosted container already
 * samples at 0.9 on its own.
 */

import {
  FISH_S2_EMOTION_CUES,
  isAllowedFishS2Cue,
} from "@/lib/tts/fish-s2-cues";
import { isChapterHeading, isSpeakableHeading, splitSentences } from "@/lib/tts/speakable-text";

export type PerformanceMark = {
  /** Collapsed lowercase prefix of the kept line. */
  anchor: string;
  cue: string;
};

const CROWD_CUES = new Set([
  "audience laughing",
  "background laughter",
  "crowd laughing",
  "snoring",
]);

/** Delivery that may continue into the next quoted sentence. */
const CARRY_CUES = new Set(["whispering", "soft tone", "shouting"]);

const EMOTION_CUES: ReadonlySet<string> = new Set(FISH_S2_EMOTION_CUES);

const LEXICAL: ReadonlyArray<{ pattern: RegExp; cue: string }> = [
  {
    pattern: /\b(?:whisper(?:ed|ing|s)?|in a whisper|under (?:her|his|their|my) breath)\b/i,
    cue: "whispering",
  },
  { pattern: /\b(?:shout(?:ed|ing|s)?|yell(?:ed|ing|s)?|bellow(?:ed|ing|s)?)\b/i, cue: "shouting" },
  { pattern: /\bscream(?:ed|ing|s)?\b/i, cue: "screaming" },
  { pattern: /\bsigh(?:ed|ing|s)?\b/i, cue: "sighing" },
  { pattern: /\bgasp(?:ed|ing|s)?\b/i, cue: "gasping" },
  { pattern: /\bchuckl(?:e|ed|ing|es)\b/i, cue: "chuckling" },
  { pattern: /\blaugh(?:ed|ing|s)?\b/i, cue: "laughing" },
  { pattern: /\bsobb(?:ed|ing)\b/i, cue: "sobbing" },
  { pattern: /\bpant(?:ed|ing|s)?\b/i, cue: "panting" },
  {
    pattern: /\b(?:breathless|out of breath|in a (?:hurry|rush)|hurried)\b/i,
    cue: "in a hurry tone",
  },
  { pattern: /\b(?:murmur(?:ed|ing|s)?|softly|in a soft voice)\b/i, cue: "soft tone" },
];

/** At most this many model marks are kept from one listen-prep chunk. */
export const FISH_PERFORMANCE_MARKS_PER_CHUNK = 8;

/**
 * Appended to the listen-prep system prompt only while the flag is on.
 * Kept short so it stays inside the existing output budget.
 */
export const FISH_PERFORMANCE_MARKS_INSTRUCTION =
  'Also include "marks": a list of {"id":"<line id>","cue":"<one cue>"} for a line whose meaning clearly changes how it is spoken. ' +
  "cue is one of: whispering, soft tone, emphasis, in a hurry tone, shouting, screaming, sighing, gasping, panting, chuckling, laughing, sobbing, " +
  "happy, sad, angry, excited, calm, nervous, confident, surprised, scared, worried, hopeful, sarcastic, determined, resigned, moved, grateful. " +
  "At most 8 marks. One cue per line. Ordinary narration is []. Do not put the cue in replacement text.";

const marksByUpload = new Map<string, PerformanceMark[]>();

export function fishPerformanceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.FISH_S2_PERFORMANCE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

export function rememberFishPerformanceMarks(
  uploadId: string,
  marks: PerformanceMark[]
): void {
  marksByUpload.set(uploadId, marks);
}

export function takeFishPerformanceMarks(
  uploadId: string
): PerformanceMark[] | undefined {
  return marksByUpload.get(uploadId);
}

export function peekFishPerformanceMarks(
  uploadId: string | null | undefined
): PerformanceMark[] {
  if (!uploadId || !fishPerformanceEnabled()) return [];
  return marksByUpload.get(uploadId) ?? [];
}

export function clearFishPerformanceMarks(): void {
  marksByUpload.clear();
}

export function uploadIdFromContentPath(
  path: string | null | undefined
): string | null {
  const match = /^pdfs\/([^/]+)\/content\.txt$/.exec(path ?? "");
  return match?.[1] ?? null;
}

/**
 * Hosted Fish sampling override. Null unless `FISH_S2_HOSTED_SAMPLING`
 * is on, so the performance flag does not change the request body.
 * The API default is 0.7/0.7. 0.9 adds sample variance; on a clone that
 * variance is timbre, and fish-speech #1280 found higher temperatures
 * add variability rather than making a tag stronger.
 */
export function fishHostedSampling(
  env: NodeJS.ProcessEnv = process.env
): { temperature: number; topP: number } | null {
  const flag = env.FISH_S2_HOSTED_SAMPLING?.trim().toLowerCase();
  if (flag !== "1" && flag !== "true" && flag !== "on") return null;
  const raw = env.MODAL_S2_SAMPLING?.trim() || "0.9,0.9";
  const [temperature, topP] = raw.split(",");
  return {
    temperature: clampSample(Number(temperature)),
    topP: clampSample(Number(topP)),
  };
}

function clampSample(value: number): number {
  if (!Number.isFinite(value)) return 0.9;
  const clamped = Math.min(1, Math.max(0.06, value));
  return Math.round(clamped * 1000) / 1000;
}

/** A cue we will insert. Pauses, crowd effects, and unknown tags are refused. */
export function canonicalPerformanceCue(inner: string): string | null {
  const cue = inner.trim().toLowerCase().replace(/\s+/g, " ");
  if (!cue || CROWD_CUES.has(cue) || cue === "break" || cue === "long-break") return null;
  if (!isAllowedFishS2Cue(cue)) return null;
  return cue;
}

/** Prefix used to find a kept line inside a later speakable section. */
export function performanceAnchor(line: string): string | null {
  const collapsed = line.replace(/\s+/g, " ").trim().toLowerCase();
  if (collapsed.length < 8) return null;
  return collapsed.slice(0, 48);
}

export function normalizePerformanceMarks(raw: unknown): PerformanceMark[] {
  if (!Array.isArray(raw)) return [];
  const out: PerformanceMark[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as { anchor?: unknown; cue?: unknown };
    if (typeof row.anchor !== "string" || typeof row.cue !== "string") continue;
    const cue = canonicalPerformanceCue(row.cue);
    const anchor = row.anchor.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 48);
    if (!cue || anchor.length < 8) continue;
    out.push({ anchor, cue });
    if (out.length >= 256) break;
  }
  return out;
}

export function resolveChunkMarks(
  marks: ReadonlyArray<{ id: number; cue: string }> | undefined,
  lines: ReadonlyArray<{ id: number; text: string }>,
  dropped: ReadonlyArray<number>,
  replacements: ReadonlyArray<{ id: number; text: string }>
): PerformanceMark[] {
  if (!fishPerformanceEnabled() || !marks?.length) return [];
  const droppedSet = new Set(dropped);
  const replacement = new Map(replacements.map((row) => [row.id, row.text]));
  const out: PerformanceMark[] = [];
  for (const mark of marks) {
    if (droppedSet.has(mark.id)) continue;
    const line = lines.find((row) => row.id === mark.id);
    if (!line) continue;
    const cue = canonicalPerformanceCue(mark.cue);
    const anchor = performanceAnchor(replacement.get(mark.id) ?? line.text);
    if (!cue || !anchor) continue;
    out.push({ anchor, cue });
    if (out.length >= FISH_PERFORMANCE_MARKS_PER_CHUNK) break;
  }
  return out;
}

function lexicalCue(sentence: string): string | null {
  for (const row of LEXICAL) {
    if (row.pattern.test(sentence)) return row.cue;
  }
  return null;
}

function isHeadingParagraph(paragraph: string): boolean {
  const line = paragraph.replace(/\s+/g, " ").trim();
  if (!line || line.length > 120) return false;
  return isSpeakableHeading(line) || isChapterHeading(line);
}

function continuesDelivery(sentence: string): boolean {
  const text = sentence.trim();
  return /^["“']/.test(text) || /^\p{Ll}/u.test(text);
}

/**
 * Delete every square bracket and the words inside it.
 *
 * A tag Fish does not treat as a cue is spoken as a word. That includes
 * an unknown tag, a bracket that never closed, and a tag cut in half at
 * a listen-prep chunk or a section boundary (`[whis` / `pering]`).
 * A cut opener at the end of a line takes the short tail with it. A cut
 * closer drops the token stuck to `]`. A bracket with sentence
 * punctuation after it drops only that one token, so the rest of the
 * line is still read.
 */
export function stripUnspokenBrackets(text: string): string {
  if (!text.includes("[") && !text.includes("]")) return text;
  return text
    .split("\n")
    .map((line) => {
      let rest = line.replace(/\[[^\[\]]*\]/g, " ");
      rest = rest.replace(/\[[^\[\]]*$/g, (tail) => {
        if (tail.length <= 48 && !/[.!?…]/.test(tail)) return " ";
        return tail.replace(/^\[[^\s\[\]]*/, " ");
      });
      rest = rest.replace(/(?:^|\s)[^\s\[\]]{0,48}\]/g, " ");
      return rest.replace(/[\[\]]/g, "").replace(/[^\S\n]{2,}/g, " ").trim();
    })
    .join("\n");
}

function stripTags(sentence: string): string {
  return stripUnspokenBrackets(sentence).replace(/[^\S\n]{2,}/g, " ").trim();
}

function insideDoubleQuotes(sentence: string, index: number): boolean {
  let open = false;
  for (let i = 0; i < index; i++) {
    const ch = sentence[i];
    if (ch === '"') open = !open;
    else if (ch === "“") open = true;
    else if (ch === "”") open = false;
  }
  return open;
}

/** A pause cue inside a quote, a number, or an abbreviation can be read aloud. */
function breakWouldBeSpoken(sentence: string, at: number): boolean {
  if (insideDoubleQuotes(sentence, at)) return true;
  const around = sentence.slice(Math.max(0, at - 6), at + 8);
  if (/\d/.test(around)) return true;
  const left = sentence.slice(Math.max(0, at - 12), at);
  return /(?:Mr|Mrs|Ms|Dr|St|Prof|Sr|Jr|vs|etc|e\.g|i\.e)\.\s*$/i.test(left);
}

function hasLetters(sentence: string): boolean {
  return /\p{L}/u.test(sentence);
}

function insertSentenceBreak(sentence: string): string {
  if (sentence.length <= 160 || /\[break\]/i.test(sentence)) return sentence;
  const marks = ["...", "…", " — ", " – "];
  let at = -1;
  let length = 0;
  for (const mark of marks) {
    const found = sentence.indexOf(mark);
    if (found < 40) continue;
    if (sentence.length - (found + mark.length) < 40) continue;
    if (at < 0 || found < at) {
      at = found;
      length = mark.length;
    }
  }
  if (at < 0 || breakWouldBeSpoken(sentence, at)) return sentence;
  const left = sentence.slice(0, at).trimEnd();
  const right = sentence.slice(at + length).trimStart();
  const kept = sentence.slice(at, at + length).trim();
  if (!left || !right || !hasLetters(right)) return sentence;
  return `${left} ${kept} [break] ${right}`;
}

type SentencePlan = {
  text: string;
  cues: string[];
};

function paragraphPlans(
  paragraph: string,
  marks: readonly PerformanceMark[],
  incoming: string | null,
  budget: { tags: number; breaks: number; sinceEmotion: number }
): { plans: SentencePlan[]; carry: string | null } {
  const sentences = splitSentences(paragraph);
  const rows = (sentences.length ? sentences : [paragraph]).map((sentence) => ({
    text: stripTags(sentence),
  }));
  const blob = rows
    .map((row) => row.text.replace(/\s+/g, " ").trim().toLowerCase())
    .join(" ");
  const spans: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const row of rows) {
    const piece = row.text.replace(/\s+/g, " ").trim().toLowerCase();
    spans.push({ start: cursor, end: cursor + piece.length });
    cursor += piece.length + 1;
  }
  const modelAt = new Map<number, string>();
  for (const mark of marks) {
    const at = blob.indexOf(mark.anchor);
    if (at < 0) continue;
    const index = spans.findIndex((span) => at >= span.start && at < span.end);
    if (index < 0 || modelAt.has(index)) continue;
    modelAt.set(index, mark.cue);
  }

  let carry = incoming;
  const plans = rows.map((row, index) => {
    const text = row.text;
    if (!hasLetters(text)) {
      carry = null;
      return { text, cues: [] };
    }
    const cues: string[] = [];
    const lexical = lexicalCue(text);
    const model = modelAt.get(index) ?? null;
    const carried =
      !lexical && !model && carry && continuesDelivery(text) ? carry : null;
    const want = [lexical, carried && carried !== lexical ? carried : null].filter(
      (cue): cue is string => Boolean(cue)
    );
    for (const cue of want) {
      if (cues.length >= 2 || budget.tags <= 0) break;
      if (!cues.includes(cue)) {
        cues.push(cue);
        budget.tags -= 1;
      }
    }
    const emotion = model != null && EMOTION_CUES.has(model);
    if (
      model &&
      !cues.includes(model) &&
      cues.length < 2 &&
      budget.tags > 0 &&
      (!emotion || budget.sinceEmotion >= 400)
    ) {
      cues.push(model);
      budget.tags -= 1;
      if (emotion) budget.sinceEmotion = 0;
    }
    budget.sinceEmotion += text.length;
    const applied = cues.find((cue) => CARRY_CUES.has(cue));
    carry = applied ?? null;
    let spoken = text;
    if (budget.breaks > 0) {
      const withBreak = insertSentenceBreak(spoken);
      if (withBreak !== spoken) {
        spoken = withBreak;
        budget.breaks -= 1;
      }
    }
    return { text: spoken, cues };
  });
  return { plans, carry };
}

function annotate(
  text: string,
  marks: readonly PerformanceMark[],
  incoming: string | null
): { text: string; carry: string | null } {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/[^\S\n]+/g, " ").trim())
    .filter(Boolean);
  const budget = {
    tags: Math.max(6, Math.floor(text.length / 350)),
    breaks: 2,
    sinceEmotion: 400,
  };
  const parts: string[] = [];
  let carry: string | null = incoming;
  for (const paragraph of paragraphs) {
    if (isHeadingParagraph(paragraph)) {
      parts.push(stripTags(paragraph));
      carry = null;
      continue;
    }
    const planned = paragraphPlans(paragraph, marks, carry, budget);
    const spoken = planned.plans
      .filter((plan) => hasLetters(plan.text))
      .map((plan) =>
        plan.cues.length
          ? `${plan.cues.map((cue) => `[${cue}]`).join(" ")} ${plan.text}`
          : plan.text
      );
    if (spoken.length) parts.push(spoken.join(" "));
    carry = planned.carry;
  }
  return {
    text: parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim(),
    carry,
  };
}

function trailingDelivery(
  previous: string,
  marks: readonly PerformanceMark[]
): string | null {
  const plain = previous.replace(/\r\n/g, "\n").trim();
  if (!plain) return null;
  return annotate(plain, marks, null).carry;
}

/**
 * Cache identity for one section.
 * Flag off hashes the frozen source, the same bytes as today.
 * Flag on hashes the spoken script, so a whisper carry and a plain
 * reading of the same section do not share a take.
 */
export function fishSectionCacheText(source: string, spoken: string): string {
  return fishPerformanceEnabled() ? spoken : source;
}

/**
 * Insert validated tags into text that is already plain.
 * Unknown brackets are removed. A tag with no words after it is dropped.
 */
export function applyFishPerformance(
  plain: string,
  opts?: { previousText?: string; marks?: readonly PerformanceMark[] }
): string {
  const text = (plain ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!text) return "";
  const marks = (opts?.marks ?? []).filter(
    (mark) => canonicalPerformanceCue(mark.cue) === mark.cue
  );
  const incoming = opts?.previousText?.trim()
    ? trailingDelivery(opts.previousText, marks)
    : null;
  return annotate(text, marks, incoming).text;
}
