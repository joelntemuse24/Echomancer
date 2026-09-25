/**
 * Prepare extracted document text for TTS.
 *
 * Fish (and other speech models) will spell emails letter-by-letter, say
 * "punct" for ".", and rush through title-page metadata. Strip those tokens
 * and obvious cover/affiliation blocks so char counts and Fish spend match
 * what is actually spoken.
 *
 * Glued PDF extracts (no blank lines) also need structure back: headings
 * must not be fused into the next sentence, and long academic blocks need
 * paragraph breaks so the narrator can pause. Pause *tags* are applied later
 * in `narration-script.ts` — this module only restores readable script.
 */

import { normalizeSpeakableText } from "@/lib/tts/normalize-speakable";

export { normalizeSpeakableText } from "@/lib/tts/normalize-speakable";

const EMAIL_RE =
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/** `contact @ google . com` — leftover dots become "punct" if we miss these. */
const SPACED_EMAIL_RE =
  /\b[A-Za-z0-9._%+-]+\s*@\s*[A-Za-z0-9.-]+\s*\.\s*[A-Za-z]{2,}\b/g;

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>\]]+/gi;

const DOI_RE = /\bdoi:\s*10\.\S+/gi;

const ARXIV_RE = /\barxiv:\s*[0-9]+\.[0-9]+(?:v\d+)?/gi;

const ISSN_RE = /\bissn[:\s]+\d{4}[-\s]?\d{3}[\dx]\b/gi;

const NAME_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "all",
  "at",
  "by",
  "for",
  "from",
  "in",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
  "you",
  "your",
]);

const AFFILIATION_PHRASE_RE = new RegExp(
  [
    String.raw`\b(?:Google|Facebook|Meta|Microsoft|Amazon|OpenAI|DeepMind|Apple)\s+(?:Brain|Research|AI|Labs?)\b`,
    String.raw`\bUniversity of [\p{Lu}][\p{L}.-]+(?:\s+[\p{Lu}][\p{L}.-]+)?\b`,
    String.raw`\b[\p{Lu}][\p{L}.-]+(?:\s+[\p{Lu}][\p{L}.-]+)?\s+University\b`,
    String.raw`\b(?:Department|Dept\.|Institute|Laboratory|School) of [\p{Lu}][\p{L}\s.-]{2,40}`,
  ].join("|"),
  "gu"
);

/** Venue lines only — never `[\s\S]*$`, which wipes glued papers through EOF. */
const CONFERENCE_PHRASE_RE =
  /\d+(?:st|nd|rd|th)\s+Conference\b[^.!?\n]{0,180}[.!?]*/giu;

const PROCEEDINGS_PHRASE_RE =
  /\bProceedings of\b[^.!?\n]{0,180}[.!?]*/giu;

const FIGURE_REPRO_GRANT_RE =
  /\bProvided proper attribution is provided\b[^.!?\n]{0,280}[.!?]*/giu;

const GOOGLE_REPRODUCE_GRANT_RE =
  /\bGoogle hereby grants permission to reproduce\b[^.!?\n]{0,240}[.!?]*/giu;

const EQUAL_CONTRIBUTION_RE =
  /\bEqual contribution\.\s+Listing order is random\b[\s\S]{0,2000}?(?=\bWork performed while at\b|\d+(?:st|nd|rd|th)\s+Conference\b|\bProceedings of\b|\bAbstract\b|\b(?:\d+\.?\s+)?Introduction\b|$)/gi;

const WORK_PERFORMED_RE =
  /\bWork performed while at\b(?:\s+[\p{Lu}][\p{L}.-]*){0,8}\s*[.,;:]?/gu;

const WORK_PERFORMED_DANGLING_RE = /\bWork performed while at\b\s*[.,;:]?/gi;

/**
 * Academic / book headings we split out of glued extracts.
 * Same-line lookahead only — `\s` would rematch across `\n\n` and break
 * idempotency.
 */
const SECTION_HEADING_NAMES =
  "Abstract|Introduction|Background|Related Works?|Preliminaries|Methods?|Approach|Model Architecture|Experiments|Results|Discussion|Conclusions?|Acknowledgements?|References|Bibliography|Appendix";

/**
 * Front/back matter. `Notes` is exact-line only (below) so a sentence that
 * starts with "Notes on…" is not split out of the prose.
 */
const BOOK_MATTER_SPLIT =
  "Foreword|Preface|Prologue|Epilogue|Afterword|Coda|Postscript|Endnotes";

const BOOK_MATTER_LINE =
  "Foreword|Preface|Prologue|Epilogue|Afterword|Coda|Postscript|Endnotes|Notes";

const HEADING_SPLIT_RE = new RegExp(
  `(^|[.!?])[ \\t]*((?:\\d+(?:\\.\\d+)*\\.?\\s+)?(?:${SECTION_HEADING_NAMES}|${BOOK_MATTER_SPLIT}))(?=[ \\t]+[\\p{Lu}])`,
  "giu"
);

const CHAPTER_WORD_NUMBERS =
  "One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve|Thirteen|Fourteen|Fifteen|Sixteen|Seventeen|Eighteen|Nineteen|Twenty|Thirty|Forty|Fifty";

const CHAPTER_SPLIT_RE = new RegExp(
  `(^|[.!?])[ \\t]*((?:Chapter|Part|Section)\\s+(?:\\d+|[IVXLCDM]+|(?:${CHAPTER_WORD_NUMBERS}))[^.!\\n]{0,80}?)(?=[ \\t]+[\\p{Lu}])`,
  "giu"
);

const NUMBERED_HEADING_SPLIT_RE =
  /(^|[.!?])[ \t]*(\d+(?:\.\d+)*\.?\s+[\p{Lu}][\p{L}'-]{2,}(?:\s+[\p{Lu}][\p{L}'-]{2,}){0,6})(?=[ \t]+[\p{Lu}])/gu;

const DISCOURSE_START_RE =
  /^(?:However|Moreover|Furthermore|In this (?:paper|work|section)|We (?:propose|present|introduce|show)|The (?:goal|dominant|best)|This (?:paper|section|work))\b/i;

function collapseWs(s: string): string {
  return s.replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function countMatches(re: RegExp, text: string): number {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const clone = new RegExp(re.source, flags);
  return (text.match(clone) || []).length;
}

function looksAcademicCover(text: string): boolean {
  const emails =
    countMatches(EMAIL_RE, text) + countMatches(SPACED_EMAIL_RE, text);
  if (emails >= 2) return true;
  const hasAffil = AFFILIATION_PHRASE_RE.test(text);
  AFFILIATION_PHRASE_RE.lastIndex = 0;
  const hasConf =
    /\d+(?:st|nd|rd|th)\s+Conference\b/i.test(text) ||
    /\bProceedings of\b/i.test(text);
  return emails >= 1 && (hasAffil || hasConf);
}

export function stripUnspeakableTokens(text: string): string {
  return text
    .replace(SPACED_EMAIL_RE, " ")
    .replace(EMAIL_RE, " ")
    .replace(URL_RE, " ")
    .replace(DOI_RE, " ")
    .replace(ARXIV_RE, " ")
    .replace(ISSN_RE, " ");
}

function stripFootnoteMarks(token: string): string {
  return token.replace(/[*∗†‡§0-9]+$/gu, "");
}

function isPersonName(tokens: string[]): boolean {
  if (tokens.length < 2 || tokens.length > 4) return false;
  const cleaned = tokens.map((t) => stripFootnoteMarks(t).replace(/\.$/, ""));
  if (cleaned.some((t) => NAME_STOPWORDS.has(t.toLowerCase()))) return false;
  return cleaned.every((t) => /^[\p{Lu}][\p{L}'-]*$/u.test(t) && t.length >= 1);
}

function hasAuthorFootnote(tokens: string[]): boolean {
  return tokens.some((t) => /[*∗†‡§]/.test(t));
}

function consumePersonName(tokens: string[], i: number): number {
  // Academic author lists use footnote marks (∗†‡). Requiring them avoids
  // eating title words ("Need Ashish") as fake First Last pairs.
  if (i + 3 <= tokens.length) {
    const slice = tokens.slice(i, i + 3);
    const mid = stripFootnoteMarks(tokens[i + 1]!).replace(/\.$/, "");
    if (
      /^[\p{Lu}]$/u.test(mid) &&
      isPersonName(slice) &&
      hasAuthorFootnote(slice)
    ) {
      return 3;
    }
  }
  if (i + 2 <= tokens.length) {
    const slice = tokens.slice(i, i + 2);
    if (isPersonName(slice) && hasAuthorFootnote(slice)) return 2;
  }
  return 0;
}

function stripAuthorSequences(text: string): string {
  const tokens = text.split(/\s+/).filter(Boolean);
  const keep: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const consumed = consumePersonName(tokens, i);
    if (consumed) {
      i += consumed;
      continue;
    }
    keep.push(tokens[i]!);
    i += 1;
  }
  return keep.join(" ");
}

function stripAffiliationPhrases(text: string): string {
  AFFILIATION_PHRASE_RE.lastIndex = 0;
  return text.replace(AFFILIATION_PHRASE_RE, " ");
}

function stripConferencePhrases(text: string): string {
  CONFERENCE_PHRASE_RE.lastIndex = 0;
  PROCEEDINGS_PHRASE_RE.lastIndex = 0;
  return text
    .replace(CONFERENCE_PHRASE_RE, " ")
    .replace(PROCEEDINGS_PHRASE_RE, " ");
}

function stripLegalBoilerplate(text: string): string {
  FIGURE_REPRO_GRANT_RE.lastIndex = 0;
  GOOGLE_REPRODUCE_GRANT_RE.lastIndex = 0;
  return text
    .replace(FIGURE_REPRO_GRANT_RE, " ")
    .replace(GOOGLE_REPRODUCE_GRANT_RE, " ");
}

function stripEqualContribution(text: string): string {
  EQUAL_CONTRIBUTION_RE.lastIndex = 0;
  return text.replace(EQUAL_CONTRIBUTION_RE, " ");
}

function stripWorkPerformedWhileAt(text: string): string {
  WORK_PERFORMED_RE.lastIndex = 0;
  WORK_PERFORMED_DANGLING_RE.lastIndex = 0;
  return text
    .replace(WORK_PERFORMED_RE, " ")
    .replace(WORK_PERFORMED_DANGLING_RE, " ");
}

function stripCoverJunk(text: string): string {
  let p = stripLegalBoilerplate(text);
  p = stripEqualContribution(p);
  p = stripWorkPerformedWhileAt(p);
  p = stripAffiliationPhrases(p);
  p = stripWorkPerformedWhileAt(p);
  p = stripConferencePhrases(p);
  return p;
}

/** Insert paragraph breaks so glued headings are not cover-peeled as prose. */
function splitSectionHeadings(text: string): string {
  HEADING_SPLIT_RE.lastIndex = 0;
  CHAPTER_SPLIT_RE.lastIndex = 0;
  NUMBERED_HEADING_SPLIT_RE.lastIndex = 0;
  return text
    .replace(HEADING_SPLIT_RE, "$1\n\n$2\n\n")
    .replace(CHAPTER_SPLIT_RE, (full, lead: string, heading: string, offset: number, whole: string) => {
      // The pattern is case-insensitive, so `\p{Lu}` also matches the "s" in
      // "Chapter 3 shows…". That citation must stay one sentence.
      const after = whole.slice(offset + full.length);
      if (/^[ \t]+\p{Ll}/u.test(after)) return full;
      return `${lead}\n\n${heading}\n\n`;
    })
    .replace(NUMBERED_HEADING_SPLIT_RE, "$1\n\n$2\n\n");
}

const CHAPTER_LABEL_RE = new RegExp(
  `^(chapter|part|section)\\s+(\\d+|[ivxlcdm]+|(?:${CHAPTER_WORD_NUMBERS})(?:[\\s-](?:${CHAPTER_WORD_NUMBERS}))?)\\b[:.]?\\s*(.*)$`,
  "i"
);

const WORD_ORDINALS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
};

const ROMAN_HEADING_RE =
  /^(?=[IVXLCDM]{1,12}\.?$)(?!$)M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})\.?$/i;

function romanOrdinal(token: string): number | null {
  const raw = token.trim().replace(/\.$/, "").toUpperCase();
  if (!ROMAN_HEADING_RE.test(raw)) return null;
  const values: Record<string, number> = {
    I: 1,
    V: 5,
    X: 10,
    L: 50,
    C: 100,
    D: 500,
    M: 1000,
  };
  let total = 0;
  let prev = 0;
  for (let i = raw.length - 1; i >= 0; i--) {
    const value = values[raw[i]!] ?? 0;
    total += value < prev ? -value : value;
    prev = Math.max(prev, value);
  }
  return total > 0 ? total : null;
}

function wordOrdinal(token: string): number | null {
  const parts = token.toLowerCase().split(/[\s-]+/).filter(Boolean);
  if (parts.length === 1) return WORD_ORDINALS[parts[0]!] ?? null;
  if (parts.length !== 2) return null;
  const tens = WORD_ORDINALS[parts[0]!];
  const ones = WORD_ORDINALS[parts[1]!];
  if (tens == null || ones == null) return null;
  if (tens >= 20 && tens % 10 === 0 && ones < 10) return tens + ones;
  return null;
}

function ordinalToken(token: string): number | null {
  if (/^\d+$/.test(token)) {
    const n = Number(token);
    return n > 0 && n < 1000 ? n : null;
  }
  const word = wordOrdinal(token);
  if (word) return word;
  return romanOrdinal(token);
}

export type ChapterHeadingMark = {
  kind: "chapter" | "part" | "section";
  n: number;
};

/**
 * Chapter / part / section label that is a title, not a sentence.
 * "Chapter 3: Duel and Reciprocity" counts. "Chapter 3 shows that…" does not.
 */
export function chapterHeadingMark(text: string): ChapterHeadingMark | null {
  const t = text.trim();
  if (!t || t.length > 120) return null;
  const match = t.match(CHAPTER_LABEL_RE);
  if (!match) return null;
  const rest = (match[3] || "").trim();
  if (rest && /^[a-z]/.test(rest)) return null;
  if (/[.!?](?:\s+\S)/.test(rest)) return null;
  if (rest.split(/\s+/).filter(Boolean).length > 14) return null;
  const n = ordinalToken(match[2] || "");
  if (n == null) return null;
  const kind = (match[1] || "chapter").toLowerCase() as ChapterHeadingMark["kind"];
  return { kind, n };
}

export function chapterHeadingOrdinal(text: string): number | null {
  return chapterHeadingMark(text)?.n ?? null;
}

/** Repeat key for a running header. A titled line is not the bare "Chapter 1" header. */
export function chapterHeaderNorm(text: string): string | null {
  const mark = chapterHeadingMark(text);
  if (!mark) return null;
  const rest = (text.trim().match(CHAPTER_LABEL_RE)?.[3] || "").trim();
  return rest ? `${mark.kind}:${mark.n}:titled` : `${mark.kind}:${mark.n}`;
}

export type ChapterHeadingState = {
  seen: Set<string>;
  max: Partial<Record<ChapterHeadingMark["kind"], number>>;
};

export function freshChapterHeadingState(): ChapterHeadingState {
  return { seen: new Set(), max: {} };
}

function dropSeenKind(state: ChapterHeadingState, kind: ChapterHeadingMark["kind"]) {
  const prefix = `${kind}:`;
  for (const key of state.seen) {
    if (key.startsWith(prefix)) state.seen.delete(key);
  }
  delete state.max[kind];
}

/**
 * First "Chapter 3" opens a chapter. A later "Chapter 3", or a "Chapter 1"
 * after chapter 4, is a citation or a leftover running header.
 * A part clears chapter and section numbers so "Part Two / Chapter 1" starts again.
 * A chapter clears section numbers so each chapter can have its own Section 1.
 */
export function acceptStructuralHeading(text: string, state: ChapterHeadingState): boolean {
  const mark = chapterHeadingMark(text);
  if (!mark) return true;
  const key = `${mark.kind}:${mark.n}`;
  const max = state.max[mark.kind] ?? 0;
  if (state.seen.has(key) || mark.n < max) return false;
  if (mark.kind === "part") {
    dropSeenKind(state, "chapter");
    dropSeenKind(state, "section");
  } else if (mark.kind === "chapter") {
    dropSeenKind(state, "section");
  }
  state.seen.add(key);
  state.max[mark.kind] = mark.n;
  return true;
}

/** Novel / academic chapter marker that must start a new packed section. */
export function isChapterHeading(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (chapterHeadingMark(t)) return true;
  if (t.length > 80) return false;
  if (isSpeakableHeading(t)) return true;
  if (ROMAN_HEADING_RE.test(t)) return true;
  if (isShortAllCapsTitle(t)) return true;
  return false;
}

function isShortAllCapsTitle(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 60) return false;
  if (!/\p{L}/u.test(t)) return false;
  if (/\p{Ll}/u.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 8) return false;
  const letters = (t.match(/\p{L}/gu) || []).length;
  return letters >= 3;
}

export function isBookMatterHeading(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 80) return false;
  return new RegExp(`^(?:${BOOK_MATTER_LINE})$`, "i").test(t);
}

export function isSpeakableHeading(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (isBookMatterHeading(t)) return true;
  if (new RegExp(`^(?:${SECTION_HEADING_NAMES})$`, "i").test(t)) return true;
  if (
    new RegExp(
      `^(?:\\d+(?:\\.\\d+)*\\.?\\s+)?(?:${SECTION_HEADING_NAMES})$`,
      "i"
    ).test(t) &&
    t.length < 80
  ) {
    return true;
  }
  if (chapterHeadingOrdinal(t) != null) return true;
  if (ROMAN_HEADING_RE.test(t) && t.length < 12) return true;
  if (
    /^\d+(?:\.\d+)*\.?\s+[\p{Lu}][\p{L}'-]*(?:\s+[\p{L}'-]+)*$/u.test(t) &&
    t.length < 80
  ) {
    return true;
  }
  return false;
}

function isSubstantialProse(text: string): boolean {
  const t = text.trim();
  if (t.length >= 140) return true;
  return t.length >= 80 && /[.?!]/.test(t);
}

function isDropAnywhere(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/^©/.test(t) || /^&copy;/i.test(t)) return true;
  if (/©/.test(t) && t.length < 240) return true;
  if (/^(copyright)\b/i.test(t)) return true;
  if (/\bcopyright\b/i.test(t) && t.length < 200) return true;
  if (/^\d+(?:st|nd|rd|th)\s+Conference\b/i.test(t) && t.length < 280) {
    return true;
  }
  if (/^Proceedings of\b/i.test(t) && t.length < 280) return true;
  if (/^Provided proper attribution\b/i.test(t) && t.length < 400) return true;
  if (/\bgrants permission to reproduce\b/i.test(t) && t.length < 400) {
    return true;
  }
  if (/^Equal contribution\b/i.test(t) && t.length < 280) return true;
  if (/^Work performed while at\b/i.test(t) && t.length < 200) return true;
  if (/^(doi:|arxiv:|issn\b)/i.test(t)) return true;
  if (/^https?:\/\//i.test(t)) return true;
  if (isAffiliationLine(t)) return true;
  return false;
}

function isAffiliationLine(text: string): boolean {
  const t = text.trim();
  if (
    /^(?:Google|Facebook|Meta|Microsoft|Amazon|OpenAI|DeepMind|Apple)\s+(?:Brain|Research|AI|Labs?)$/i.test(
      t
    )
  ) {
    return true;
  }
  if (/^University of /i.test(t)) return true;
  if (/University$/i.test(t) && t.length < 80) return true;
  if (/^(Department|Dept\.|Institute|Laboratory|School) of /i.test(t)) {
    return true;
  }
  return false;
}

function isAuthorOnlyLine(text: string): boolean {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  return isPersonName(tokens);
}

function extractCoverTitle(para: string): string | null {
  let p = stripCoverJunk(para);
  p = stripAuthorSequences(p);
  p = p.replace(/[*∗†‡§]+/gu, " ");
  p = p.replace(/\s+/g, " ").trim();
  if (!p) return null;
  if (isDropAnywhere(p) || isAuthorOnlyLine(p) || isAffiliationLine(p)) {
    return null;
  }
  return p;
}

export function isAbbreviationBoundary(chunk: string, next: string): boolean {
  if (
    /(?:\b(?:Mr|Mrs|Ms|Dr|St|Prof|Sr|Jr|vs|etc)|(?:\be\.g|\bi\.e))\.$/i.test(
      chunk
    )
  ) {
    return true;
  }
  if (/(?:^|\s)(?:[A-Z]\.)+$/.test(chunk)) return true;
  return /\bNo\.$/i.test(chunk) && /^\d/.test(next);
}

export function splitSentences(text: string): string[] {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return [];
  const parts: string[] = [];
  const boundary = /[.!?](?=\s+[\p{Lu}"“\d])/gu;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(trimmed))) {
    const end = match.index + 1;
    const chunk = trimmed.slice(start, end);
    const next = trimmed.slice(end).trimStart();
    if (isAbbreviationBoundary(chunk, next)) continue;
    parts.push(chunk.trim());
    start = end;
    while (trimmed[start] === " ") start += 1;
  }
  const rest = trimmed.slice(start).trim();
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

/**
 * Only split long, high chars/sentence blocks (glued academic). Short
 * "A sentence. " loops and novels with existing `\n\n` stay intact.
 */
function splitDenseParagraph(para: string): string[] {
  const t = para.trim();
  if (!t || isSpeakableHeading(t) || t.length < 400) return [t];
  const sentences = splitSentences(t);
  if (sentences.length < 3) return [t];
  const avg = t.length / sentences.length;
  if (avg < 80) return [t];

  const groups: string[][] = [];
  let current: string[] = [];
  for (const sentence of sentences) {
    const startsNew =
      current.length >= 2 && DISCOURSE_START_RE.test(sentence);
    if (current.length && (startsNew || current.length >= 3)) {
      groups.push(current);
      current = [sentence];
    } else {
      current.push(sentence);
    }
  }
  if (current.length) groups.push(current);
  return groups.map((g) => g.join(" "));
}

/**
 * Turn extracted document text into something a narrator can read.
 * Idempotent. Preserves headings and body sentences. Restores paragraph
 * breaks so Fish can pause — does not insert provider-specific pause tags.
 */
export function toSpeakableText(
  raw: string,
  opts?: { normalizeTitles?: boolean }
): string {
  if (!raw || !raw.trim()) return "";

  const source = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const academicCover = looksAcademicCover(source);
  let stripped = stripUnspeakableTokens(source);
  stripped = stripLegalBoilerplate(stripped);
  if (academicCover) {
    stripped = stripEqualContribution(stripped);
    stripped = stripWorkPerformedWhileAt(stripped);
  }
  stripped = splitSectionHeadings(stripped);

  const paragraphs = stripped
    .split(/\n\s*\n/)
    .map((block) => collapseWs(block.replace(/\n/g, " ")))
    .filter(Boolean);

  const hasBody =
    paragraphs.some(isSubstantialProse) || paragraphs.some(isSpeakableHeading);

  const out: string[] = [];
  let seenBody = false;

  for (const para of paragraphs) {
    let p = stripAffiliationPhrases(para);
    p = p.replace(/\s+/g, " ").trim();
    if (!p) continue;
    if (isDropAnywhere(p)) continue;

    // Glued title pages are long enough to look like prose — peel them first.
    if (hasBody && !seenBody && academicCover && !isSpeakableHeading(p)) {
      const title = extractCoverTitle(p);
      if (title) out.push(title);
      continue;
    }

    if (isSpeakableHeading(p) || isSubstantialProse(p)) {
      seenBody = true;
      out.push(p);
      continue;
    }

    out.push(p);
  }

  return normalizeSpeakableText(
    out.flatMap(splitDenseParagraph).join("\n\n").trim(),
    { normalizeTitles: opts?.normalizeTitles }
  );
}
