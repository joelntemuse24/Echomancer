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

import { collapseDropCap } from "@/lib/source-text";
import {
  flattenListsAndTables,
  normalizeSpeakableText,
} from "@/lib/tts/normalize-speakable";
import { decodeHtmlEntities } from "@/lib/html-article";

export { normalizeSpeakableText } from "@/lib/tts/normalize-speakable";

const EMAIL_RE =
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/** `contact @ google . com` — leftover dots become "punct" if we miss these. */
/** Spaces stay on one line. A newline must not become the domain or the next word. */
const SPACED_EMAIL_RE =
  /\b[A-Za-z0-9._%+-]+[ \t]*@[ \t]*[A-Za-z0-9.-]+[ \t]*\.[ \t]*[A-Za-z]{2,}\b/g;

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

const BOOK_MATTER_LINE_RE = new RegExp(`^(?:${BOOK_MATTER_LINE})\\.?$`, "i");

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

/**
 * Academic section numbers only: "1 Introduction", "2.1 Background".
 * A decimal inside a measurement ("32.5 White", "year.5 The") is not a heading.
 */
const NUMBERED_HEADING_SPLIT_RE =
  /(^|[.!?])[ \t]*(\d{1,2}(?:\.\d{1,2}){0,3}\.?\s+[\p{Lu}][\p{L}'-]{2,}(?:\s+[\p{Lu}][\p{L}'-]{2,}){0,6})(?=[ \t]+[\p{Lu}])/gu;

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

/** `[label](https://…)` — a markdown link, which must become its label. */
const MARKDOWN_LINK_RE = /\[([^\[\]]+)\]\(\s*<?(?:https?:\/\/|www\.)[^)\s]*>?\s*\)/gi;

/**
 * A preposition that a URL sits behind: "Read it at https://…". Dropping only
 * the URL leaves "Read it at", which the narrator reads as a dangling clause,
 * so the preposition goes with it.
 */
const URL_LEAD_IN_RE =
  /\b(?:at|on|via|from|in|to|through|see|visit)\s+(?:https?:\/\/|www\.)[^\s<>)\]]+/gi;

/** `press@example.com` behind the same preposition problem. */
const EMAIL_LEAD_IN_RE =
  /\b(?:at|to|via|by|on)\s+[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gi;

/**
 * An address listed beside another contact ("me@site or @handle"): the address
 * goes but the conjunction stays, so the sentence keeps its second item. When
 * the address was the only item, the same rule would leave "me: or @jane", so
 * a dangling conjunction before a mention is cleaned after the strip.
 */
const LISTED_EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\s+(or|and)\b/gi;
/** Emoji and pictographs carry no spoken words; some voices read their names. */
const PICTOGRAPH_RE =
  /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}]/gu;

/** Editorial insertions that must never be spoken. */
const EDITORIAL_INSERTION_RE = /\[(?:sic|ed\.|cite|emphasis|italics?)\]\s*/gi;

/**
 * Text hygiene shared by every intake path: markdown links become their
 * label, a URL or address behind a preposition takes the preposition with it,
 * and emoji and editorial insertions are dropped. This runs before the bare
 * URL rules so a link is never left as `[label](`.
 *
 * Raw entities are decoded here too: a page copied out of a browser can
 * arrive as `&amp;`, and a voice would otherwise read "amp".
 */
export function stripLinkAndSymbolNoise(text: string): string {
  return decodeHtmlEntities(text)
    .replace(MARKDOWN_LINK_RE, "$1")
    .replace(EDITORIAL_INSERTION_RE, "")
    .replace(LISTED_EMAIL_RE, "$1")
    .replace(URL_LEAD_IN_RE, " ")
    .replace(EMAIL_LEAD_IN_RE, " ")
    .replace(PICTOGRAPH_RE, "")
    .replace(/[^\S\n]{2,}/g, " ");
}

/**
 * "@jane on Bluesky" names a person; the handle itself is not spoken.
 * Runs after the address rules so an email never loses its local part.
 */
export function stripSocialHandles(text: string): string {
  return text
    .replace(/[,;:]?\s*(?:or|and)\s+@\w[\w.-]*/gi, " ")
    .replace(/(^|[\s(])@\w[\w.-]*/g, "$1")
    .replace(/[^\S\n]{2,}/g, " ");
}

export function stripUnspeakableTokens(text: string): string {
  return stripSocialHandles(
    stripLinkAndSymbolNoise(text)
      .replace(SPACED_EMAIL_RE, " ")
      .replace(EMAIL_RE, " ")
      .replace(URL_RE, " ")
      .replace(DOI_RE, " ")
      .replace(ARXIV_RE, " ")
      .replace(ISSN_RE, " ")
  );
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
  return splitGluedChapterHeading(
    text
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
    .replace(NUMBERED_HEADING_SPLIT_RE, (full, lead: string, heading: string, offset: number, whole: string) => {
      if (!acceptAcademicNumberSplit(whole, offset, lead, heading)) return full;
      return `${lead}\n\n${heading}\n\n`;
    })
  );
}

const GLUED_TITLE_SMALL =
  /^(?:a|an|the|of|and|or|but|to|in|on|for|with|from|by|at|as|into|over|under)$/i;

/**
 * "Chapter VIII Closing Out from the garden" is a title glued to the
 * sentence under it. The title stays title-case; the body starts at the
 * first lowercase word that is not a small word inside the title.
 * "Chapter 3 shows…" stays one sentence.
 */
function splitGluedChapterHeading(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length > 240) return line;
      const match = /^(chapter|part|section)\s+(?:\d+|[ivxlcdm]+)\s+(\S.*)$/i.exec(trimmed);
      if (!match) return line;
      const words = (match[2] ?? "").split(/\s+/).filter(Boolean);
      if (words.length < 3) return line;
      let splitAt = -1;
      for (let i = 0; i < words.length; i++) {
        const core = words[i]!.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
        if (!core || /^\p{Lu}/u.test(core) || /\d/.test(core)) continue;
        if (!/^\p{Ll}/u.test(core)) continue;
        const laterTitle = words.slice(i + 1, i + 8).some((word) => {
          const next = word.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
          return /^\p{Lu}/u.test(next);
        });
        if (GLUED_TITLE_SMALL.test(core) && laterTitle) continue;
        splitAt = i;
        break;
      }
      if (splitAt <= 0) return line;
      const body = words.slice(splitAt).join(" ");
      if (body.length < 8) return line;
      const heading = trimmed.slice(0, trimmed.length - body.length).trim();
      if (heading.length < 8 || heading.length > 80) return line;
      return `${heading}\n\n${body}`;
    })
    .join("\n");
}

const CITATION_MONTH =
  "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec";

/**
 * A footnote or endnote, not a numbered step.
 * "10. Luke Emerson and David Rudman, The Plunging Price of Thought, Epic AI, September 22, 2026."
 */
export function isFootnoteCitation(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 24 || t.length > 420) return false;
  const author =
    /^\d{1,3}\.\s+(?:[\p{Lu}][\p{L}'’.-]+(?:\s+[\p{Lu}][\p{L}'’.-]+){0,3}(?:\s+and\s+[\p{Lu}][\p{L}'’.-]+(?:\s+[\p{Lu}][\p{L}'’.-]+){0,3})?),\s+\p{Lu}/u;
  if (!author.test(t)) return false;
  if ((t.match(/,/g) || []).length < 2) return false;
  const dated = new RegExp(
    `\\b(?:${CITATION_MONTH})\\.?\\s+\\d{1,2},?\\s+(?:1[5-9]\\d{2}|20\\d{2})\\b|\\b(?:1[5-9]\\d{2}|20\\d{2})\\b`,
    "i"
  );
  return dated.test(t);
}

/**
 * A contents row whose entries were joined into one line.
 * "Chapter I The Beginning Chapter II The Middle" is the list, not the book.
 */
export function isRunTogetherContents(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 24 || t.length > 600) return false;
  const markers = t.match(/\b(?:chapter|part|book)\s+(?:\d+|[ivxlcdm]{1,8})\b/gi) ?? [];
  if (markers.length >= 2) {
    const prose = t.match(/\b\p{Ll}{4,}(?:\s+\p{Ll}{2,}){2,}/gu) ?? [];
    if (prose.length > 0 && markers.length < 4) return false;
    return true;
  }
  const pairs =
    t.match(/(?:^|\s)\p{Lu}[\p{L}'’]+(?:\s+\p{Lu}[\p{L}'’]+){0,5}\s+\d{1,3}(?=\s|$)/gu) ?? [];
  return pairs.length >= 3 && !/[.!?]/.test(t);
}

/** A figure credit. The picture is not in the audiobook. */
export function stripSourceCaption(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (/^source\s*:/i.test(t)) return "";
  return t
    .replace(/(?:^|(?<=[.!?])\s+)Source\s*:\s*[^.!?\n]*(?:[.!?])?/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.!?])/g, "$1")
    .trim();
}

/**
 * The punctuation before the number must not be the dot in "word.5" or "32.5".
 * A two-digit integer plus a single decimal digit ("32.5") is a measurement.
 */
function acceptAcademicNumberSplit(
  whole: string,
  offset: number,
  lead: string,
  heading: string
): boolean {
  if (lead === "." && offset > 0 && /[\p{L}\d]/u.test(whole[offset - 1] ?? "")) return false;
  const num = /^(\d{1,2}(?:\.\d{1,2}){0,3})/u.exec(heading)?.[1] ?? "";
  const [wholeNum, frac] = num.split(".");
  const integer = Number(wholeNum);
  if (frac && frac.length === 1 && integer >= 10) return false;
  return true;
}

const HEADING_FUNCTION_WORD =
  /^(?:a|an|the|of|and|or|but|to|in|on|for|with|from|by|at|as|into|over|under)$/i;

/** "32.5" is a measurement. "4.2" and "3.1.1" are section numbers. */
function academicDecimalOk(num: string): boolean {
  const parts = num.split(".");
  const frac = parts[1];
  return !(frac && frac.length === 1 && parts.length === 2 && Number(parts[0]) >= 10);
}

/**
 * "1 Introduction" and "2.1 Background". Also "4.2 SQuAD v1.1" and
 * "3.1 Language Modeling, Cloze, and Completion Tasks".
 * Not "5 White" or "32.5 White".
 */
export function isAcademicNumberedHeading(text: string): boolean {
  const t = text.trim();
  if (t.length > 120 || t.length < 3) return false;
  if (NUMBERED_SECTION_LINE_RE.test(t)) return true;
  const strict = /^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+(\p{Lu}[\p{L}'-]*(?:\s+\p{L}[\p{L}'-]*)*)$/u.exec(
    t
  );
  if (strict) {
    const num = strict[1] ?? "";
    const rest = strict[2] ?? "";
    if (!academicDecimalOk(num)) return false;
    const words = rest.split(/\s+/).filter(Boolean);
    const last = words[words.length - 1] ?? "";
    if (HEADING_FUNCTION_WORD.test(last)) return false;
    // "5 cups flour" and "12 miles" are quantities, not sections.
    if (
      !num.includes(".") &&
      /^(?:cups?|tablespoons?|tbsp|teaspoons?|tsp|ounces?|oz|pounds?|lbs?|grams?|kilograms?|liters?|milliliters?|quarts?|pints?|gallons?|miles?|feet|foot|inches|inch|yards?|acres?|meters?|kilometers?|hours?|minutes?|seconds?|days?|weeks?|months?|years?|decades?|centuries|percent|dollars?|cents?|pounds?|euros?|degrees?|pages?|lines?|words?|chapters?|parts?|books?|volumes?|men|women|people|boys|girls|children|things|ways|times|steps|points|items|pieces|slices|cloves|pinches)\b/i.test(
        words[0] ?? ""
      )
    ) {
      return false;
    }
    if (words.length >= 2) return true;
    const word = words[0] ?? "";
    if (word.length < 4 || HEADING_FUNCTION_WORD.test(word)) return false;
    // "5 White" is a measurement scrap. "4.1 Setup" and "5 Training" are headings.
    if (!num.includes(".") && word.length <= 5) return false;
    return true;
  }
  // A version token or a comma knocks the title out of the letter-only pattern.
  const wide = /^(\d{1,2}(?:\.\d{1,2}){1,3})\.?\s+(\S(?:.*\S)?)$/u.exec(t);
  if (!wide) return false;
  const num = wide[1] ?? "";
  const rest = wide[2] ?? "";
  if (!academicDecimalOk(num)) return false;
  if (!/^\p{Lu}/u.test(rest)) return false;
  if (/\.\s+\p{Ll}/u.test(rest)) return false;
  const words = rest.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 14) return false;
  const last = words[words.length - 1]!.replace(/[^\p{L}]/gu, "");
  if (HEADING_FUNCTION_WORD.test(last)) return false;
  if (/\.\s/u.test(rest)) return false;
  const letters = (rest.match(/\p{L}/gu) || []).length;
  if (letters < 4) return false;
  // A sentence that merely starts with a measurement ("0.3 F1 behind…") is
  // not a heading. Title words are capitalized; "and" / "v1.1" may sit inside.
  return words.every((word) => {
    const core = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!core) return false;
    if (HEADING_FUNCTION_WORD.test(core)) return true;
    if (/^v?\d+(?:\.\d+)*$/i.test(core)) return true;
    return /^\p{Lu}/u.test(core);
  });
}

/**
 * Appendix headings that pdf.js leaves on their own line.
 * "A.2 Pre-training Procedure", "B Detailed Experimental Setup", "B.1 …".
 * "A City on a Hill" is a sentence, not an appendix: a function word gives it away.
 */
export function isAppendixHeadingLine(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 80 || t.length < 4) return false;
  if (isContentsEntryLine(t)) return false;
  if (/^[A-H](?:\.\d+){1,3}\.?\s+\p{Lu}/u.test(t)) {
    const last = t.split(/\s+/).pop()?.replace(/[^\p{L}]/gu, "") ?? "";
    return !HEADING_FUNCTION_WORD.test(last);
  }
  const bare = /^[A-H]\s+(.+)$/u.exec(t);
  if (!bare) return false;
  const words = (bare[1] ?? "").split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 8) return false;
  // "B Detailed Experimental Setup", not a formula token ("C T1 T[sep]").
  if (!words.every((word) => /^\p{Lu}[\p{L}'’-]{2,}$/u.test(word))) return false;
  return !words.some((word) => HEADING_FUNCTION_WORD.test(word));
}

/** A line pdf.js can keep apart because it is a real chapter label, not a shape. */
export function isLayoutHeadingLine(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 120) return false;
  if (isContentsEntryLine(t)) return false;
  if (isBookMatterHeading(t) || isBookOrVolumeLine(t)) return true;
  if (/^(?:chapter|part|section|book|volume)\b/i.test(t) && t.length <= 80) return true;
  // "1 Introduction", "3.1 Routing", "4.2 SQuAD v1.1", and "A.2 Pre-training
  // Procedure" are their own PDF lines. Joining them into the sentence above
  // hides the heading from the outline.
  if (isAppendixHeadingLine(t)) return true;
  if (isChapterHeading(t)) return true;
  return false;
}

export function isBareRomanHeading(text: string): boolean {
  const t = text.trim();
  // "I" alone is a chapter in a book numbered only by ordinal (The Time
  // Machine, Metamorphosis, Heart of Darkness). `romanOrdinal` rejects a lone
  // C/D/M/L because those are also plain letters, but "I" has no such use at
  // the start of a paragraph.
  if (t === "I" || t === "I.") return true;
  return ROMAN_HEADING_RE.test(t) && t.replace(/\.$/, "").length > 1 && t.length < 12;
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
    return n > 0 && n <= 100000 ? n : null;
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

const BOOK_VOLUME_WORD =
  "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen";

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

function isNotesLabel(text: string): boolean {
  const t = text.trim();
  return t.length <= 40 && /^(?:notes|endnotes|references)\b/i.test(t);
}

function isIndexLabel(text: string): boolean {
  const t = text.trim();
  return t.length <= 40 && /^index\b/i.test(t);
}

function isMatterTitle(text: string): boolean {
  return /^(?:introduction|epilogue|prologue|preface|foreword|notes|endnotes|references)$/i.test(
    text.trim()
  );
}
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

const BARE_LABEL_RE = new RegExp(
  `^(?:chapter|part|section)\\s+${CHAPTER_NUMBER_SRC}\\s*[:.]?\\s*$`,
  "i"
);
/** A numeral alone: "12", "XII.", "I". Chapters numbered that way print it. */
const BARE_ORDINAL_RE = /^(?:\d{1,3}|[IVXLCDM]{1,8})\.?$/i;

function isBareLabel(text: string): boolean {
  return BARE_LABEL_RE.test(text.trim());
}

/** "12", "XII." or "Chapter 3" with nothing else: a number, not a title. */
function isBareNumberHeading(text: string): boolean {
  const t = text.trim();
  return BARE_ORDINAL_RE.test(t) || isBareLabel(t);
}

/** "Chapter 3 shows…" is one sentence. A lowercase title on its own line is not. */
function continuesOnSameLine(text: string): boolean {
  const match = text.trim().match(CHAPTER_LABEL_RE);
  if (!match) return false;
  const rest = (match[3] || "").trim();
  if (!/^\p{Ll}/u.test(rest)) return false;
  if (/^(?:of|is|was|are|shows|describes|explains)\b/.test(rest)) return true;
  return text.trim().length > 80;
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
/**
 * True when the line after `index` reads as a prose sentence rather than
 * another heading. Used to tell a numbered section title ("30 When" followed
 * by a sentence) from a title-page line such as a publisher address (followed
 * by another short line).
 */
function nextLineIsSentence(index: number, blocks: string[]): boolean {
  const next = blocks[index + 1]?.trim() ?? "";
  if (next.length < 40) return false;
  return /[.!?]/.test(next);
}

/**
 * A numeral that is also an English word: "I", "V" (versus), "C", "D", "L", "M".
 * "I." alone is a line break after "…said", not a chapter, unless it opens one.
 * "II" and up are unambiguous, so a book numbered by ordinal keeps its chapters.
 */
const BARE_PRONOUN_NUMERAL_RE = /^(?:I|V|C|D|L|M)\.?$/;

/**
 * True when a bare numeral really opens a chapter: the block under it starts a
 * sentence rather than continuing a quotation, and either a chapter title sits
 * immediately above it or it opens the book.
 */
function opensChapter(blocks: string[], index: number): boolean {
  const next = blocks[index + 1]?.trim() ?? "";
  if (!next) return false;
  // A continuation of the line above reads as dialogue.
  if (/^["“‘'’]/.test(next)) return false;
  if (next.length < 40) return false;
  // A dialogue tag that broke onto its own line ("…he said" / "I." / "‘No
  // excuse…") is prose around a numeral. The tell is that the block above is
  // itself a long run of prose that stops mid-sentence.
  const above = index > 0 ? (blocks[index - 1]?.trim() ?? "") : "";
  if (above.length >= 40 && !/[.!?…”’]\s*$/.test(above)) return false;
  return true;
}

/**
 * A chapter title with a whole page of prose under it: the title line, then the
 * first body paragraph. Unlike a title-page line (which is followed by another
 * short line) it opens a chapter.
 *
 * Used only to protect a heading that the front-matter scan would otherwise
 * drop as title-page furniture.
 */
function isChapterTitleBlock(
  item: { index: number; body: number; text: string },
  blocks: string[]
): boolean {
  const text = item.text.trim();
  if (text.length < 6 || text.length > 90) return false;
  if (!/^(?:\d{1,3}|[IVXLCDM]{1,8}|(?:chapter|part|book|volume|section|letter|act|scene)\b)/i.test(text)) {
    return false;
  }
  // Two or more title words after the number, and no sentence punctuation at
  // the end: "I. A SCANDAL IN BOHEMIA" is a title; "Chapter I. It was a dark…"
  // is prose that happens to start with a label.
  const rest = text.replace(/^(?:\d{1,3}|[IVXLCDM]{1,8})\.?\s*/i, "").trim();
  if (rest.length < 4 || /[.,;:]$/.test(rest)) return false;
  if (rest.split(/\s+/).length < 2) return false;
  const next = blocks[item.index + 1]?.trim() ?? "";
  // A chapter number set on its own line ("I. A SCANDAL IN BOHEMIA" then "I.")
  // sits between the title and its prose.
  const body = BARE_ORDINAL_RE.test(next) ? (blocks[item.index + 2]?.trim() ?? "") : next;
  if (body.length < 40) return false;
  return /^["“‘'’]?\p{Lu}/u.test(body);
}

export function playbackHeadingFlags(blocks: string[]): boolean[] {
  const flags = blocks.map(() => false);
  const nonempty: number[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i]!.trim()) nonempty.push(i);
  }

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

  // A Contents table is a dense block of headings with no text between them:
  // the "Contents" line, any Book/Part lines, and the bare labels all go.
  // Real structure always has sentences under a heading, so a block of five
  // or more bare labels with at most a page number between entries is never
  // the body. A Book/Part line whose successor has a real body is the book's
  // own structure, so it ends the block instead of joining it.
  let denseStart = 0;
  while (denseStart < items.length) {
    let denseEnd = denseStart;
    while (denseEnd < items.length && items[denseEnd]!.body <= 3) {
      const next = items[denseEnd + 1];
      if (next && next.body > REAL_BODY && !isBareLabel(items[denseEnd]!.text)) break;
      denseEnd += 1;
    }
    if (denseEnd - denseStart >= 5) {
      let bare = 0;
      let lastBare: ChapterHeadingMark | null = null;
      for (let i = denseStart; i < denseEnd; i++) {
        if (isBareLabel(items[i]!.text)) {
          bare += 1;
          lastBare = items[i]!.mark;
        }
      }
      if (bare >= 5) {
        for (let i = denseStart; i < denseEnd; i++) drop.add(items[i]!.index);
        // The table's last row absorbs the first body paragraph as its
        // "body". It continues the table's numbering; a real first chapter
        // restarts it, so only the continuation is dropped.
        const trailing = items[denseEnd];
        if (
          trailing &&
          lastBare &&
          isBareLabel(trailing.text) &&
          trailing.mark &&
          trailing.mark.kind === lastBare.kind &&
          trailing.mark.n === lastBare.n + 1
        ) {
          drop.add(trailing.index);
        }
      }
    }
    denseStart = Math.max(denseEnd, denseStart + 1);
  }

  let firstReal = items.length;
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.body > REAL_BODY) {
      firstReal = i;
      break;
    }
  }
  const laterRealNumber = new Array<number>(items.length).fill(-1);
  const laterRealTitle = new Array<number>(items.length).fill(-1);
  const nextRealByNumber = new Map<string, number>();
  const nextRealByTitle = new Map<string, number>();
  const isPartBoundary = (text: string) =>
    isBookOrVolumeLine(text) || /^part\b/i.test(text);
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (isPartBoundary(item.text)) {
      nextRealByNumber.clear();
      nextRealByTitle.clear();
    }
    const numKey = item.mark ? `${item.mark.kind}:${item.mark.n}` : "";
    if (numKey) laterRealNumber[i] = nextRealByNumber.get(numKey) ?? -1;    laterRealTitle[i] = nextRealByTitle.get(item.titleKey) ?? -1;
    if (isMatterTitle(item.text)) nextRealByTitle.set(item.titleKey, i);
    if (item.body > REAL_BODY && numKey) nextRealByNumber.set(numKey, i);
    // A title whose own text is empty because its sub-heading follows directly
    // is still in the body. Moby-Dick Chapter 40 ("CHAPTER 40. Midnight,
    // Forecastle." sits directly above "HARPOONEERS AND SAILORS.") is a song,
    // so the lines under it never reach REAL_BODY on their own and the contents
    // row for it survived — appearing ahead of Chapter 1.
    if (
      numKey &&
      item.body === 0 &&
      i + 1 < items.length &&
      items[i + 1]!.index === item.index + 1 &&
      items[i + 1]!.body > REAL_BODY
    ) {
      nextRealByNumber.set(numKey, i);
    }
  }
  // The intro-blurb rule: before the first real body, a Chapter line that reads
  // like a summary and has a real chapter of the same number later is the
  // contents blurb for it. It only applies when that later chapter is the
  // *first* one of that number — a book whose chapters restart ("Book Two:
  // Chapter I") would otherwise drop every first chapter but the last.
  for (let i = 0; i < firstReal; i++) {
    const item = items[i]!;
    if (!item.mark || !isIntroSummary(item.text)) continue;
    const later = laterRealNumber[i]!;
    if (later < 0) continue;
    const firstWithNumber = items.findIndex(
      (other) => other.mark?.kind === item.mark!.kind && other.mark.n === item.mark!.n && other.body > REAL_BODY
    );
    if (firstWithNumber >= 0 && firstWithNumber >= i && items[firstWithNumber]!.index !== item.index) {
      if (firstWithNumber !== i) drop.add(item.index);
    }
  }

  /**
   * A contents table whose rows carry titles, not just bare labels.
   *
   * Moby-Dick's contents page reads `CHAPTER 1. Loomings.` through
   * `CHAPTER 135. The Chase.—Third Day.` — the same text as the body, so the
   * bare-label run and the intro-blurb rule both miss it and the whole page
   * survives as 135 chapter markers *ahead* of the 135 real ones.
   *
   * Three things separate the table from the body:
   *
   * - the leading run counts 1, 2, 3 … with no gap and no Book/Part boundary,
   * - every row in that run is a *stub*, with no prose under it,
   * - and the body then starts over at 1.
   *
   * A book whose chapters restart inside a Book ("Book Two: Chapter I") never
   * produces that opening run. Nor do endnotes that repeat the chapter titles,
   * because their rows in the body have prose under them and so are not stubs.
   */
  {
    let restartAt = -1;
    let expected = 1;
    let sawPartBoundary = false;
    let sawProseInRun = false;
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (isPartBoundary(item.text)) {
        // A part boundary before any restart means this is a chaptered book in
        // parts, not a contents page.
        sawPartBoundary = true;
        break;
      }
      const mark = item.mark;
      if (!mark || mark.kind !== "chapter") continue;
      if (mark.n !== expected) {
        // The first number that breaks the run either restarts it (a contents
        // page is over) or skips (this is not a plain contents page).
        if (mark.n === 1 && expected > 1) restartAt = i;
        break;
      }
      if (item.body > REAL_BODY) sawProseInRun = true;
      expected += 1;
    }
    // Only a run of stubs is a table worth removing.
    if (!sawPartBoundary && !sawProseInRun && restartAt > 0 && expected > 5) {
      const bodyIndex = new Map<number, number>();
      for (let i = restartAt; i < items.length; i++) {
        const mark = items[i]!.mark;
        if (!mark || mark.kind !== "chapter") continue;
        if (!bodyIndex.has(mark.n)) bodyIndex.set(mark.n, i);
      }
      let dropped = 0;
      for (let i = 0; i < restartAt; i++) {
        const mark = items[i]!.mark;
        if (!mark || mark.kind !== "chapter") continue;
        if (!bodyIndex.has(mark.n)) continue;
        drop.add(items[i]!.index);
        dropped += 1;
      }
      if (dropped < 5) {
        for (let i = 0; i < restartAt; i++) {
          const mark = items[i]!.mark;
          if (!mark || mark.kind !== "chapter") continue;
          if (bodyIndex.has(mark.n)) drop.delete(items[i]!.index);
        }
      }
    }
  }
  let runStart = 0;
  while (runStart < items.length) {
    if (isPartBoundary(items[runStart]!.text) || items[runStart]!.body >= REAL_BODY) {
      runStart += 1;
      continue;
    }
    let runEnd = runStart;
    while (
      runEnd < items.length &&
      !isPartBoundary(items[runEnd]!.text) &&
      items[runEnd]!.body < REAL_BODY
    ) {
      runEnd += 1;
    }
    if (runEnd - runStart >= 3) {
      for (let i = runStart; i < runEnd; i++) {
        if (items[i]!.body > REAL_BODY) continue;
        const matter =
          /^(?:introduction|epilogue|prologue|preface|foreword|notes|endnotes|references)$/i.test(
            items[i]!.text.trim()
          ) && laterRealTitle[i]! >= 0;
        if (laterRealNumber[i]! >= 0 || matter) {
          drop.add(items[i]!.index);
        }
      }
      // A long streak of bare "Chapter N" labels with no text between them
      // is a Contents table even when the real chapters were never found.
      // Short streaks can be a real chapter followed by its own section
      // heading, and a real short chapter has sentences under it — so the
      // streak needs five labels with at most a page number between them.
      let streak: number[] = [];
      const flushStreak = () => {
        if (streak.length >= 5) {
          for (const i of streak) drop.add(items[i]!.index);
        }
        streak = [];
      };
      for (let i = runStart; i < runEnd; i++) {
        if (isBareLabel(items[i]!.text) && items[i]!.body <= 3) {
          streak.push(i);
        } else {
          flushStreak();
        }
      }
      flushStreak();
    }
    runStart = Math.max(runEnd, runStart + 1);
  }
  const firstNumbered = items.findIndex((item) => item.mark?.kind === "chapter" && item.body > REAL_BODY);
  const matterLimit = firstNumbered === -1 ? 0 : firstNumbered;
  for (let i = 0; i < items.length; i++) {
    if (!isMatterTitle(items[i]!.text) || laterRealTitle[i]! < 0) continue;
    if (items[i]!.body < REAL_BODY || i < matterLimit) drop.add(items[i]!.index);
  }

  /**
   * Front matter: flagged headings that sit before the book's first labelled
   * heading and are not themselves labelled.
   *
   * A title page is typeset like a heading list — book title, publisher,
   * address, edition — so detection flags those lines; they are short and
   * title-cased. None of them names a part of the book, so the scan stops at
   * the first heading that does (PREFACE, CHAPTER I, Book the First).
   */
  let firstLabelledAt = -1;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    // A chapter that opens the book with its own title line and prose under it
    // is labelled too. Project Gutenberg's plain-text Holmes has no `Contents`
    // banner, so its first story is otherwise read as title-page furniture.
    if (
      item.mark ||
      isChapterOrPartLabel(item.text) ||
      isMatterTitle(item.text) ||
      isBookMatterHeading(item.text) ||
      isChapterTitleBlock(item, blocks)
    ) {
      firstLabelledAt = i;
      break;
    }
  }
  if (firstLabelledAt > 0) {
    for (let i = 0; i < firstLabelledAt; i++) {
      const item = items[i]!;
      // "30 When" is a numbered section title that happens to precede the
      // first labelled heading, so it is not front matter. A publisher address
      // ("156 Charing Cross Road London") has the same shape, so shape alone
      // cannot decide — but a section title is followed by a sentence, and a
      // title-page line is followed by another short line.
      if (/^\d+\s+\p{Lu}/u.test(item.text.trim()) && nextLineIsSentence(item.index, blocks)) continue;
      drop.add(item.index);
    }
  }

  /**
   * A contents list can also be labelled ("Book the First"), in which case the
   * pass above leaves it. The body prints the same label again later, so a
   * label that repeats is kept only at its *last* occurrence — the body copy.
   *
   * Scoped to the region before the first chapter, so a label legitimately
   * repeated inside the body ("Part Two" twice in one chapter) is untouched.
   */
  let firstChapterIndex = -1;
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.mark?.kind === "chapter") {
      firstChapterIndex = i;
      break;
    }
  }
  if (firstChapterIndex > 0) {
    // Compare against the whole book, not just the region before chapter one:
    // "Book the Second" appears in the contents and again 96,000 characters
    // later at its real position. Keep only the last front copy when the body
    // never repeats the label, and drop every front copy when it does.
    //
    // Restricted to part/book/volume labels on purpose. A *chapter* number
    // restarts inside a later book or volume ("Book Two: Chapter I"), so
    // deduplicating chapters by title would delete real chapters.
    const partKey = (item: (typeof items)[number]): string =>
      isPartOrVolumeLabel(item.text) ? item.titleKey : "";
    const seenInBody = new Set<string>();
    for (let i = firstChapterIndex + 1; i < items.length; i++) {
      const key = partKey(items[i]!);
      if (key) seenInBody.add(key);
    }
    const lastInFront = new Map<string, number>();
    for (let i = 0; i <= firstChapterIndex; i++) {
      const key = partKey(items[i]!);
      if (key) lastInFront.set(key, i);
    }
    for (let i = 0; i <= firstChapterIndex && i < items.length; i++) {
      const key = partKey(items[i]!);
      if (!key) continue;
      if (seenInBody.has(key) || lastInFront.get(key) !== i) {
        drop.add(items[i]!.index);
      }
    }
  }

  const bodyChapters = new Set<string>();
  let notesMode = false;
  let indexMode = false;
  const byIndex = new Map(items.map((item) => [item.index, item]));
  for (let i = 0; i < blocks.length; i++) {
    const text = blocks[i]!.trim();
    if (!text) continue;
    const item = byIndex.get(i);
    if (!item && text.length > REAL_BODY) indexMode = false;
    if (!item && text.length > 80) continue;
    if (isNotesLabel(text)) {
      notesMode = true;
      indexMode = false;
    } else if (isIndexLabel(text)) {
      indexMode = true;
      notesMode = false;
    } else if (isBookOrVolumeLine(text) || /^part\b/i.test(text) || isPlainTitleLine(text)) {
      notesMode = false;
      indexMode = false;
    }
    if (!item || drop.has(i)) continue;
    // A label that opens the book with its own page of prose is a chapter, even
    // when a book-wide pass mistook it for a contents row. Twelve stories each
    // labelled "I. <TITLE>" read as a contents table to the row-run test.
    if (drop.has(i) && isChapterTitleBlock(item, blocks)) {
      drop.delete(i);
    }
    if (item.body > REAL_BODY) indexMode = false;
    if (notesMode && item.mark && item.body <= REAL_BODY) {
      const rest = headingRest(item.text);
      if (rest) {
        const key = `${item.mark.kind}:${item.mark.n}\n${rest.toLowerCase()}`;
        if (bodyChapters.has(key)) {
          drop.add(i);
          continue;
        }
      }
    }
    if (indexMode && isBareLabel(item.text) && item.body <= REAL_BODY) {
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
  // A bare numeral is a chapter only when nothing but prose precedes it. Once
  // a real title has opened a chapter, the next bare numeral under it is that
  // chapter's number printed on its own line.
  let previousWasHeading = false;
  let previousWasTitle = false;
  for (let pos = 0; pos < nonempty.length; pos++) {
    const index = nonempty[pos]!;
    if (!flags[index]) {
      previousWasHeading = false;
      continue;
    }
    const text = blocks[index]!.trim();
    // "I." alone between two quoted sentences is a line break after "…said",
    // not a chapter: the numeral is the pronoun. A numeral that opens the book
    // or sits under a chapter title is a real chapter number.
    if (BARE_PRONOUN_NUMERAL_RE.test(text) && !opensChapter(blocks, index)) {
      flags[index] = false;
      previousWasHeading = false;
      continue;
    }
    // A bare numeral directly under a *titled* heading is that title's own
    // number set on the next line: "I. A SCANDAL IN BOHEMIA" then "I.". It is
    // the same chapter, not a second one.
    //
    // Three bare numerals in a row are a numbered chapter list (Heart of
    // Darkness prints "I / II / III" in its contents), and each is a chapter,
    // so only a titled heading absorbs one.
    if (previousWasHeading && previousWasTitle && BARE_ORDINAL_RE.test(text)) {
      flags[index] = false;
      continue;
    }
    previousWasTitle = previousWasHeading && !BARE_ORDINAL_RE.test(text);
    previousWasHeading = !isBareNumberHeading(text);
    if (!isBareLabel(text)) continue;
    // Only labelled headings ("Chapter 3") join the duplicate map. A bare
    // numeral is matched by the ordinal rule above; adding it here would let a
    // numeral in a later chapter mark the first as a contents row.
    const key = text.toLowerCase();
    const list = headed.get(key) || [];
    list.push(pos);
    headed.set(key, list);
  }
  const itemByBlock = new Map(items.map((item) => [item.index, item]));
  for (const positions of headed.values()) {
    if (positions.length < 2) continue;
    for (let k = 1; k < positions.length; k++) {
      const prevPos = positions[k - 1]!;
      const pos = positions[k]!;
      const prevIndex = nonempty[prevPos]!;
      const index = nonempty[pos]!;
      let between = 0;
      let boundary = false;
      for (let j = prevIndex + 1; j < index; j++) {
        const block = blocks[j]!.trim();
        if (!block) continue;
        between += block.length;
        if (
          itemByBlock.has(j) ||
          isBookOrVolumeLine(block) ||
          /^part\b/i.test(block) ||
          isPlainTitleLine(block)
        ) {
          boundary = true;
        }
      }
      const prevBody = itemByBlock.get(prevIndex)?.body ?? between;
      if (boundary || prevBody > REAL_BODY || between > 200) continue;
      if (between <= 80 && index - prevIndex < 8) flags[index] = false;
    }
  }
  /**
   * A book numbered only by ordinal opens on a bare "I", which is its first
   * chapter. That numeral is indistinguishable from a contents row by shape, so
   * the whole-book passes above can drop it (Metamorphosis loses chapter one
   * this way). The rescue looks at the book's *opening* only: the first item,
   * or the first item after the front matter, must be a numeral followed by a
   * paragraph of prose.
   *
   * It runs last, because a later pass would otherwise drop it again — and it
   * only ever restores one line, so it cannot undo a real contents-table drop.
   */
  for (let i = 0; i < Math.min(items.length, 12); i++) {
    const item = items[i]!;
    if (flags[item.index]) continue;
    if (!BARE_ORDINAL_RE.test(item.text.trim())) continue;
    if (!opensChapter(blocks, item.index)) continue;
    flags[item.index] = true;
    break;
  }
  return flags;
}

/**
 * A contents row: dot leaders (or a run of spaced dots) and a page number.
 * "Chapter I" alone is a heading. "Chapter I . . . . 12" is the table.
 */
export function isContentsEntryLine(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 180) return false;
  if (!/(?:\.{3,}|(?:\.\s){3,}|…{2,}|·{3,}|_{3,})/.test(t)) return false;
  if (!/\d{1,4}\s*$/.test(t)) return false;
  const words = t
    .replace(/[.\d…·_]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.length > 0 && words.length <= 8;
}

/** Novel / academic chapter marker that must start a new packed section. */
export function isChapterHeading(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 80) return false;
  if (isContentsEntryLine(t)) return false;
  if (continuesOnSameLine(t)) return false;
  if (isSpeakableHeading(t)) return true;
  if (isStandaloneAllCapsTitle(t)) return true;
  return false;
}

/**
 * A standalone all-caps title of three or more words.
 * One- and two-word scraps ("PEOPLE", "TOO BAD") are title-page fragments.
 */
export function isStandaloneAllCapsTitle(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 60) return false;
  if (!/\p{L}/u.test(t)) return false;
  if (/\p{Ll}/u.test(t)) return false;
  const quotes = t.match(/["“”]/g)?.length ?? 0;
  if (quotes % 2 === 1) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 3 || words.length > 8) return false;
  // "II., III., IV., V.," is a contents row, not a title.
  const cores = words.map((word) => word.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ""));
  if (cores.every((core) => core.length > 0 && /^[IVXLCDM]+$/.test(core))) return false;
  const letters = (t.match(/\p{L}/gu) || []).length;
  return letters >= 8;
}

function isChapterOrPartLabel(text: string): boolean {
  const t = text.trim();
  return t.length <= 80 && /^(?:chapter|part|book|volume|section)\b/i.test(t);
}

/** "Book the First", "Volume Two", "Part Three" — a container of chapters. */
function isPartOrVolumeLabel(text: string): boolean {
  const t = text.trim();
  return t.length <= 80 && /^(?:book|volume|part)\b/i.test(t);
}

/**
 * A line that starts with a label word and then continues as a sentence.
 *
 * "part of the foot-board of the bed and a line of the wall, but no" is prose.
 * "PART ONE", "Part Two: the Golden Thread", "Chapter the Last" are headings —
 * their first meaningful word after any number is capitalised, or they are
 * short enough to be a bare label.
 */
function labelRunsOnAsProse(text: string): boolean {
  const t = text.trim();
  const rest = t.replace(/^(?:chapter|part|section)\b\s*/i, "");
  if (!rest) return false;
  // A number after the label is handled by `continuesOnSameLine`, which already
  // separates "Chapter 3 shows…" from "Chapter 1: in which we meet the crew".
  // This guard exists for the unnumbered shape only.
  if (/^(?:\d+|[ivxlcdm]+\b|one\b|two\b|three\b|four\b|five\b|six\b|seven\b|eight\b|nine\b|ten\b|eleven\b|twelve\b)/i.test(rest)) {
    return false;
  }
  // A heading starts with a capital, a quote, or a bracket.
  if (/^[\p{Lu}"“'‘(\[]/u.test(rest)) return false;
  // Otherwise it is prose if it runs on for several words.
  return rest.split(/\s+/).filter(Boolean).length >= 4;
}

export function isBookMatterHeading(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 80) return false;
  return BOOK_MATTER_LINE_RE.test(t);
}

function isOutlineHeading(text: string): boolean {
  if (isContentsEntryLine(text)) return false;
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
  if (!t || isContentsEntryLine(t)) return false;
  // A glued paragraph that merely starts with "Chapter 1." is prose, not a
  // heading. Real titles fit in a line.
  if (t.length > 160) return false;
  if (continuesOnSameLine(t)) return false;
  if (isBookMatterHeading(t) || isBookOrVolumeLine(t)) return true;
  // "CHAPTERXXVII." is one token in some EPUBs. A space is optional.
  if (/^(?:chapter|part|section|book|volume)\s*[0-9ivxlcdm]+[.:]?$/i.test(t)) return true;
  if (/^(?:first|second|third)\s+epilogue\b/i.test(t) && t.length < 80) return true;
  if (SECTION_HEADING_LINE_RE.test(t)) return true;
  if (NUMBERED_SECTION_LINE_RE.test(t) && t.length < 80) {
    return true;
  }
  if (/^(?:part|section)\b/i.test(t) && t.length > 80 && chapterLabel(t) == null) return false;
  // "part of the foot-board of the bed…" and "chapter of sounds. Yet…" are
  // running prose that happens to begin with a label word. A real heading is
  // followed by a title ("Part Two", "Chapter the Last"), never by a lowercase
  // continuation of a sentence.
  if (/^(?:chapter|part|section)\b/i.test(t) && labelRunsOnAsProse(t)) return false;
  if (/^(chapter|part|section)\b/i.test(t)) return true;
  // "IV" can be a chapter. "XIV." is a fragment left by a line break.
  if (isBareRomanHeading(t) && !t.endsWith(".")) return true;
  // "I" is a chapter in a book numbered only by ordinal (Metamorphosis, The
  // Time Machine), and `isBareRomanHeading` rejects a lone "I" because it also
  // reads as the pronoun. A period after it is punctuation, not a broken line.
  if (t === "I" || t === "I.") return true;
  if (isAcademicNumberedHeading(t)) return true;
  if (isAppendixHeadingLine(t)) return true;
  if (
    /^\d{1,3}(?:\.\d{1,2}){0,3}\.?\s+\p{Lu}[\p{L}'-]{2,}(?:\s+\p{L}[\p{L}'-]*)*$/u.test(t) &&
    t.length < 80 &&
    !/^\d{2,}\.\d\s/u.test(t)
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
  // Web-page furniture that survived extraction. Each is a whole short line
  // with no reading in it; a sentence that merely mentions sharing is longer
  // and keeps its first word.
  if (isWebFurnitureLine(t)) return true;
  return false;
}

/**
 * Share bars, "read more" teasers, subscription prompts, and author bylines.
 * A paragraph these match is never the book, so the narrator does not say
 * "Share this article: Facebook Twitter Email".
 */
export function isWebFurnitureLine(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 200) return false;
  if (/^(?:share|tweet|email|print|copy link)\b[\s:·|–-]/i.test(t)) return true;
  if (/\b(?:share this (?:article|story|post|page)|share on (?:facebook|twitter|x)|copy link)\b/i.test(t)) {
    return true;
  }
  if (/^read (?:more|next|also)\s*:/i.test(t)) return true;
  if (/^(?:subscribe|sign up)\b.{0,80}\b(?:newsletter|for \$|a week|a month|free)\b/i.test(t)) return true;
  if (/^by\s+[\p{Lu}][\p{L}.'-]+(?:\s+[\p{Lu}][\p{L}.'-]+){1,3}\s*[·|–—-]\s*\p{Lu}/u.test(t)) {
    return true;
  }
  // "· Tweet · Copy link" and other bare control rows.
  if (/^[·|•\s]*(?:share|tweet|email|print|copy link)(?:[·|•\s]+(?:share|tweet|email|print|copy link))+[·|•\s]*$/i.test(t)) {
    return true;
  }
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

const SENTENCE_START =
  /^(?:Then|The|This|That|These|Those|But|And|Or|So|Yet|When|After|Before|Once|If|He|She|They|We|It|There|Here|However|Meanwhile|Later|Soon|Now|Suddenly|Still|Also|Thus|Therefore)\b/;

function endsWithNameInitials(chunk: string): boolean {
  return /(?:^|\s)(?:[A-Z]\.\s+){1,}[A-Z]\.$/.test(chunk);
}

export function isAbbreviationBoundary(chunk: string, next: string): boolean {
  if (
    /(?:\b(?:Mr|Mrs|Ms|Dr|St|Prof|Sr|Jr|vs|etc)|(?:\be\.g|\bi\.e))\.$/i.test(
      chunk
    )
  ) {
    return true;
  }
  if (
    /\b(?:No|p|pp|Fig|vol|ch|cf|ca)\.$/i.test(chunk) &&
    /^\d/.test(next)
  ) {
    return true;
  }
  if (/(?:^|\s)(?:[A-Z]\.){2,}$/.test(chunk)) return true;
  if (/(?:^|\s)[A-Z]\.$/.test(chunk) && /^[A-Z]\./.test(next)) return true;
  if (endsWithNameInitials(chunk) && /^[A-Z][a-z]/.test(next)) return true;
  if (
    /(?:^|\s)[A-Z][a-zA-Z'’.-]*\s+[A-Z]\.$/.test(chunk) &&
    /^[A-Z][a-z]/.test(next) &&
    !SENTENCE_START.test(next)
  ) {
    return true;
  }
  return false;
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

  const source = collapseDropCap(raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
  const academicCover = looksAcademicCover(source);
  let stripped = stripUnspeakableTokens(source);
  // Lists and tables must be split before paragraphs are formed: a blank-line
  // join would fuse the whole list into one run-on sentence.
  stripped = flattenListsAndTables(stripped);
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
    if (isDropAnywhere(p) || isFootnoteCitation(p) || isRunTogetherContents(p)) continue;
    p = stripSourceCaption(p);
    if (!p) continue;

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
