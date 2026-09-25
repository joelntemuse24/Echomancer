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

const SECTION_HEADING_LINE_RE = new RegExp(`^(?:${SECTION_HEADING_NAMES})$`, "i");
const NUMBERED_SECTION_LINE_RE = new RegExp(
  `^(?:\\d+(?:\\.\\d+)*\\.?\\s+)?(?:${SECTION_HEADING_NAMES})$`,
  "i"
);

/**
 * Front/back matter. `Notes` is exact-line only (below) so a sentence that
 * starts with "Notes on…" is not split out of the prose.
 */
const BOOK_MATTER_SPLIT =
  "Foreword|Preface|Prologue|Epilogue|Afterword|Coda|Postscript|Endnotes";

const BOOK_MATTER_LINE =
  "Foreword|Preface|Prologue|Epilogue|Afterword|Coda|Postscript|Endnotes|Notes";

const BOOK_MATTER_LINE_RE = new RegExp(`^(?:${BOOK_MATTER_LINE})$`, "i");

const HEADING_SPLIT_RE = new RegExp(
  `(^|[.!?])[ \\t]*((?:\\d+(?:\\.\\d+)*\\.?\\s+)?(?:${SECTION_HEADING_NAMES}|${BOOK_MATTER_SPLIT}))(?=[ \\t]+[\\p{Lu}])`,
  "giu"
);

const CHAPTER_WORD_NUMBERS =
  "One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve|Thirteen|Fourteen|Fifteen|Sixteen|Seventeen|Eighteen|Nineteen|Twenty|Thirty|Forty|Fifty|Sixty|Seventy|Eighty|Ninety|Hundred";

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
      // A short title ("Chapter 1. The Escalation to Extremes") stays intact.
      const after = whole.slice(offset + full.length);
      if (/^[ \t]+\p{Ll}/u.test(after)) return full;
      const lineBreak = after.search(/\n/);
      const rest = lineBreak === -1 ? after : after.slice(0, lineBreak);
      const line = `${heading}${rest}`.trim();
      if (line.length <= 80) return full;
      // A long line that is itself the chapter sentence stays one paragraph.
      // "It ended there. Chapter 2 The Storm Arrives …" is a heading after
      // a sentence end, and that heading is split off.
      if (lead !== "." && lead !== "!" && lead !== "?") return full;
      return `${lead}\n\n${heading}\n\n`;
    })
    .replace(NUMBERED_HEADING_SPLIT_RE, "$1\n\n$2\n\n");
}

const CHAPTER_NUMBER_SRC =
  `(?:one\\s+hundred(?:\\s+and\\s+(?:one|two|three|four|five|six|seven|eight|nine))?|hundred(?:\\s+and\\s+(?:one|two|three|four|five|six|seven|eight|nine))?|\\d+|(?:${CHAPTER_WORD_NUMBERS})(?:[\\s-](?:${CHAPTER_WORD_NUMBERS}))?|[ivxlcdm]+)`;

const CHAPTER_LABEL_RE = new RegExp(
  `^(chapter|part|section)\\s+(${CHAPTER_NUMBER_SRC})\\b[:.]?\\s*(.*)$`,
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
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
};

const ROMAN_HEADING_RE =
  /^(?=[IVXLCDM]{1,12}\.?$)(?!$)M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})\.?$/i;

function romanOrdinal(token: string): number | null {
  const raw = token.trim().replace(/\.$/, "").toUpperCase();
  // A lone C/D/M/L is a letter, not chapter 100/500/1000/50.
  if (/^[CDML]$/.test(raw)) return null;
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
  if (parts[0] === "one" && parts[1] === "hundred") {
    if (parts.length === 2) return 100;
    if (parts.length === 4 && parts[2] === "and") {
      const ones = WORD_ORDINALS[parts[3]!];
      if (ones != null && ones < 10) return 100 + ones;
    }
    return null;
  }
  if (parts[0] === "hundred" && parts.length === 3 && parts[1] === "and") {
    const ones = WORD_ORDINALS[parts[2]!];
    if (ones != null && ones < 10) return 100 + ones;
  }
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
/** A period in "Mr. Darcy" or "MR. COLLINS" is an abbreviation, not a new sentence. */
function restHasSentenceBreak(rest: string): boolean {
  const boundary = /[.!?](?=\s+\S)/g;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(rest))) {
    const chunk = rest.slice(0, match.index + 1);
    const next = rest.slice(match.index + 1).trimStart();
    if (isAbbreviationBoundary(chunk, next)) continue;
    return true;
  }
  return false;
}

const NARRATIVE_VERB =
  /\b(?:tells|shows|describes|closes|stays|remains|appears|explains|discusses|follows|begins|ends|returns|keeps|held)\b/;

/**
 * A citation sentence, not a title. Capitalized titles stay headings even
 * when they contain "begins" or run past eight words.
 */
function isSentenceCitation(text: string): boolean {
  const t = text.trim();
  const match = t.match(CHAPTER_LABEL_RE);
  if (!match) return false;
  const rest = (match[3] || "").trim();
  if (/^[,;:“”"']/.test(rest)) return true;
  if (restHasSentenceBreak(rest)) return true;
  return /^\p{Ll}/u.test(rest) && NARRATIVE_VERB.test(rest);
}

/** Intro blurb before the first real Chapter 1: a verb, or a long sentence. */
function isIntroSummary(text: string): boolean {
  if (isSentenceCitation(text)) return true;
  const t = text.trim();
  const match = t.match(CHAPTER_LABEL_RE);
  if (!match) return false;
  const rest = (match[3] || "").trim();
  if (NARRATIVE_VERB.test(rest)) return true;
  const words = rest.split(/\s+/).filter(Boolean);
  return /[.!?]$/.test(t) && words.length >= 8;
}

export function chapterHeadingMark(text: string): ChapterHeadingMark | null {
  const t = text.trim();
  if (!t || t.length > 160) return null;
  if (isSentenceCitation(t)) return null;
  const match = t.match(CHAPTER_LABEL_RE);
  if (!match) return null;
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

const NUMBERED_JUNK_WORD =
  /^(when|then|where|while|after|before|once|this|that|there|here|what|which|with|from|into|over|upon|and|but|the|for|not|you|she|his|her|its|our|who|how|why|also|thus|such|some|many|most|each|both|they|were|have|been|will|would|could|should)$/i;

/** "1 Introduction" is a heading. "30 When" is the start of a sentence. */
export function isNumberedSectionTitle(text: string): boolean {
  const t = text.trim();
  if (!t || t.length >= 80) return false;
  if (!/^\d+(?:\.\d+)*\.?\s+[\p{Lu}][\p{L}'-]*(?:\s+[\p{L}'-]+)*$/u.test(t)) return false;
  const title = t.replace(/^\d+(?:\.\d+)*\.?\s+/, "");
  const words = title.split(/\s+/).filter(Boolean);
  if (words.length === 1 && (words[0]!.length < 5 || NUMBERED_JUNK_WORD.test(words[0]!))) return false;
  return true;
}

/**
 * A chapter line we cannot number ("Chapter the Last") still opens a section.
 * A numbered line that failed the title checks ("Chapter 3 shows…", "Chapter C") does not.
 */
export function isUnnumberedChapterTitle(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 80 || t.length < 8) return false;
  if (!/^(chapter|part|section)\b/i.test(t)) return false;
  if (chapterHeadingMark(t)) return false;
  if (/^(chapter|part|section)\s+(?:\d+|[ivxlcdm]+|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred))\b/i.test(t)) {
    return false;
  }
  if (/^(chapter|part|section)\s+\S+\s*[,;:“”"']/i.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  return words.length <= 12;
}

const BOOK_VOLUME_WORD =
  "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve";

const BOOK_OR_VOLUME_RE = new RegExp(
  `^(?:book|volume)\\s+(?:the\\s+)?(?:\\d+|[ivxlcdm]+|${BOOK_VOLUME_WORD})\\b`,
  "i"
);

export function isBookOrVolumeLine(text: string): boolean {
  return BOOK_OR_VOLUME_RE.test(text.trim());
}

function headingRest(text: string): string {
  return (text.trim().match(CHAPTER_LABEL_RE)?.[3] || "").trim();
}

const NOTES_HEADING_RE = /^(?:notes|endnotes|references)$/i;
const REAL_BODY = 200;

function isPlainTitleLine(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 80) return false;
  if (/^(?:chapter|part|section|book|volume)\b/i.test(t)) return false;
  if (/^\d+$/.test(t)) return false;
  if (/[.!?]["”’]?$/.test(t)) return false;
  if (/^\p{Ll}/u.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 12;
}

function isPageNumberLine(text: string): boolean {
  return /^\d{1,4}$/.test(text.trim());
}

const BARE_LABEL_RE = new RegExp(
  `^(?:chapter|part|section)\\s+${CHAPTER_NUMBER_SRC}\\s*[:.]?\\s*$`,
  "i"
);

function isBareLabel(text: string): boolean {
  return BARE_LABEL_RE.test(text.trim());
}

/** "Chapter 3 shows…" is one sentence. A lowercase title on its own line is not. */
function continuesOnSameLine(text: string): boolean {
  const match = text.trim().match(CHAPTER_LABEL_RE);
  if (!match) return false;
  const rest = (match[3] || "").trim();
  if (!/^\p{Ll}/u.test(rest)) return false;
  return /^(?:of|is|was|are|shows|describes|explains)\b/.test(rest);
}

function chapterLabel(text: string): ChapterHeadingMark | null {
  const match = text.trim().match(CHAPTER_LABEL_RE);
  if (!match) return null;
  const n = ordinalToken(match[2] || "");
  if (n == null) return null;
  const kind = (match[1] || "chapter").toLowerCase() as ChapterHeadingMark["kind"];
  return { kind, n };
}

type HeadItem = {
  index: number;
  text: string;
  mark: ChapterHeadingMark | null;
  body: number;
  titleKey: string;
};

/**
 * Which blocks open a player chapter.
 *
 * Candidates are main's headings. A line is removed only as one of: a contents
 * run of three or more short headings, a notes copy of the same number and
 * title, an intro sentence before the first real body, an index entry, or a
 * repeated running head beside a page number.
 */
export function playbackHeadingFlags(blocks: string[]): boolean[] {
  const flags = blocks.map(() => false);
  const nonempty: number[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i]!.trim()) nonempty.push(i);
  }

  const besidePage = (pos: number) => {
    const prev = pos > 0 ? blocks[nonempty[pos - 1]!]!.trim() : "";
    const next = pos + 1 < nonempty.length ? blocks[nonempty[pos + 1]!]!.trim() : "";
    return isPageNumberLine(prev) || isPageNumberLine(next);
  };

  const items: HeadItem[] = [];
  for (const index of nonempty) {
    const text = blocks[index]!.trim();
    if (!isOutlineHeading(text)) continue;
    const mark = chapterLabel(text);
    const rest = headingRest(text);
    items.push({
      index,
      text,
      mark,
      body: 0,
      titleKey: (rest || text).replace(/\s+/g, " ").trim().toLowerCase(),
    });
  }

  for (let i = 0; i < items.length; i++) {
    const start = items[i]!.index;
    const end = i + 1 < items.length ? items[i + 1]!.index : blocks.length;
    let size = 0;
    for (let j = start + 1; j < end; j++) size += blocks[j]!.trim().length;
    items[i]!.body = size;
  }

  const drop = new Set<number>();

  let firstReal = items.length;
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.body > REAL_BODY) {
      firstReal = i;
      break;
    }
  }
  for (let i = 0; i < firstReal; i++) {
    const item = items[i]!;
    if (item.mark && isIntroSummary(item.text)) drop.add(item.index);
  }

  const laterRealNumber = new Array<number>(items.length).fill(-1);
  const laterRealTitle = new Array<number>(items.length).fill(-1);
  const nextRealByNumber = new Map<string, number>();
  const nextRealByTitle = new Map<string, number>();
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    const numKey = item.mark ? `${item.mark.kind}:${item.mark.n}` : "";
    if (numKey) laterRealNumber[i] = nextRealByNumber.get(numKey) ?? -1;
    laterRealTitle[i] = nextRealByTitle.get(item.titleKey) ?? -1;
    if (item.body > REAL_BODY) {
      if (numKey) nextRealByNumber.set(numKey, i);
      nextRealByTitle.set(item.titleKey, i);
    }
  }
  let runStart = 0;
  while (runStart < items.length) {
    if (items[runStart]!.body >= REAL_BODY) {
      runStart += 1;
      continue;
    }
    let runEnd = runStart;
    while (runEnd < items.length && items[runEnd]!.body < REAL_BODY) runEnd += 1;
    if (runEnd - runStart >= 3) {
      for (let i = runStart; i < runEnd; i++) {
        if (laterRealNumber[i]! >= 0 || laterRealTitle[i]! >= 0) drop.add(items[i]!.index);
      }
    }
    runStart = Math.max(runEnd, runStart + 1);
  }

  const bodyChapters = new Set<string>();
  let notesMode = false;
  let indexMode = false;
  const byIndex = new Map(items.map((item) => [item.index, item]));
  for (let i = 0; i < blocks.length; i++) {
    const text = blocks[i]!.trim();
    if (!text) continue;
    if (text.length > 80 && !byIndex.has(i)) continue;
    if (NOTES_HEADING_RE.test(text)) {
      notesMode = true;
      indexMode = false;
    } else if (/^index$/i.test(text)) {
      indexMode = true;
      notesMode = false;
    } else if (isBookOrVolumeLine(text) || /^part\b/i.test(text) || isPlainTitleLine(text)) {
      notesMode = false;
      indexMode = false;
    }
    const item = byIndex.get(i);
    if (!item || drop.has(i)) continue;
    if (notesMode && item.mark) {
      const rest = headingRest(item.text);
      if (rest) {
        const key = `${item.mark.kind}:${item.mark.n}\n${rest.toLowerCase()}`;
        if (bodyChapters.has(key)) {
          drop.add(i);
          continue;
        }
      }
    }
    if (indexMode && isBareLabel(item.text)) {
      drop.add(i);
      continue;
    }
    flags[i] = true;
    if (item.mark && item.body > REAL_BODY) {
      const rest = headingRest(item.text);
      if (rest) bodyChapters.add(`${item.mark.kind}:${item.mark.n}\n${rest.toLowerCase()}`);
    }
  }

  const headed = new Map<string, number[]>();
  for (let pos = 0; pos < nonempty.length; pos++) {
    const index = nonempty[pos]!;
    if (!flags[index]) continue;
    const text = blocks[index]!.trim();
    if (!isBareLabel(text)) continue;
    const key = text.toLowerCase();
    const list = headed.get(key) || [];
    list.push(pos);
    headed.set(key, list);
  }
  for (const positions of headed.values()) {
    if (positions.length < 2) continue;
    const pageBound = positions.filter((pos) => besidePage(pos));
    if (pageBound.length === 0) {
      if (positions.length > 3) {
        for (const pos of positions.slice(1)) flags[nonempty[pos]!] = false;
      }
      continue;
    }
    const extra = pageBound.length === positions.length ? positions.slice(1) : pageBound;
    for (const pos of extra) flags[nonempty[pos]!] = false;
  }
  return flags;
}

/** Novel / academic chapter marker that must start a new packed section. */
export function isChapterHeading(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 80) return false;
  if (continuesOnSameLine(t)) return false;
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
  return BOOK_MATTER_LINE_RE.test(t);
}

function isOutlineHeading(text: string): boolean {
  if (text.length > 80) {
    const c = text.charCodeAt(0);
    // Chapter / Part / Section, either case. Anything else is prose.
    if (c !== 67 && c !== 99 && c !== 80 && c !== 112 && c !== 83 && c !== 115) return false;
    if (!/^(?:chapter|part|section)\b/i.test(text)) return false;
    return isSpeakableHeading(text);
  }
  return isChapterHeading(text);
}

export function isSpeakableHeading(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (continuesOnSameLine(t)) return false;
  if (isBookMatterHeading(t)) return true;
  if (SECTION_HEADING_LINE_RE.test(t)) return true;
  if (NUMBERED_SECTION_LINE_RE.test(t) && t.length < 80) {
    return true;
  }
  if (/^(?:part|section)\b/i.test(t) && t.length > 80 && chapterLabel(t) == null) return false;
  if (/^(chapter|part|section)\b/i.test(t)) return true;
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
