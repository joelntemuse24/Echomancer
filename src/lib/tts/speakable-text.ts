/**
 * Prepare extracted document text for TTS.
 *
 * Fish (and other speech models) will spell emails letter-by-letter, say
 * "punct" for ".", and rush through title-page metadata. Strip those tokens
 * and obvious cover/affiliation blocks so char counts and Fish spend match
 * what is actually spoken.
 */

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

/** Insert paragraph breaks so glued Abstract/Introduction are not cover-peeled. */
function splitAcademicSectionHeadings(text: string): string {
  return text
    .replace(/(^|[.\s])(Abstract)(?=\s+[\p{Lu}])/gu, "$1\n\n$2\n\n")
    .replace(
      /(^|[.\s])((?:\d+\.?\s+)?Introduction)(?=\s+[\p{Lu}])/gu,
      "$1\n\n$2\n\n"
    );
}

function isSectionHeading(text: string): boolean {
  const t = text.trim();
  if (/^abstract$/i.test(t)) return true;
  if (/^(?:\d+\.?\s+)?introduction$/i.test(t)) return true;
  if (/^(chapter|part|section)\b/i.test(t)) return true;
  if (/^\d+\s+[\p{Lu}][\p{L}'-]*(?:\s+[\p{L}'-]+)*$/u.test(t) && t.length < 80) {
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

/**
 * Turn extracted document text into something a narrator can read.
 * Idempotent. Preserves headings and body sentences.
 */
export function toSpeakableText(raw: string): string {
  if (!raw || !raw.trim()) return "";

  const source = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const academicCover = looksAcademicCover(source);
  let stripped = stripUnspeakableTokens(source);
  stripped = stripLegalBoilerplate(stripped);
  if (academicCover) {
    stripped = stripEqualContribution(stripped);
    stripped = stripWorkPerformedWhileAt(stripped);
    stripped = splitAcademicSectionHeadings(stripped);
  }

  const paragraphs = stripped
    .split(/\n\s*\n/)
    .map((block) => collapseWs(block.replace(/\n/g, " ")))
    .filter(Boolean);

  const hasBody =
    paragraphs.some(isSubstantialProse) || paragraphs.some(isSectionHeading);

  const out: string[] = [];
  let seenBody = false;

  for (const para of paragraphs) {
    let p = stripAffiliationPhrases(para);
    p = p.replace(/\s+/g, " ").trim();
    if (!p) continue;
    if (isDropAnywhere(p)) continue;

    // Glued title pages are long enough to look like prose — peel them first.
    if (hasBody && !seenBody && academicCover && !isSectionHeading(p)) {
      const title = extractCoverTitle(p);
      if (title) out.push(title);
      continue;
    }

    if (isSectionHeading(p) || isSubstantialProse(p)) {
      seenBody = true;
      out.push(p);
      continue;
    }

    out.push(p);
  }

  return out.join("\n\n").trim();
}
