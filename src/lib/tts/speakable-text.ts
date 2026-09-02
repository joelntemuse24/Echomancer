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

const CONFERENCE_TAIL_RE =
  /\d+(?:st|nd|rd|th)\s+Conference\b[\s\S]*$/giu;

const PROCEEDINGS_TAIL_RE = /\bProceedings of\b[\s\S]*$/giu;

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
  return text
    .replace(CONFERENCE_TAIL_RE, " ")
    .replace(PROCEEDINGS_TAIL_RE, " ");
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
  if (/^\d+(?:st|nd|rd|th)\s+Conference\b/i.test(t)) return true;
  if (/\bProceedings of\b/i.test(t)) return true;
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
  let p = stripAffiliationPhrases(para);
  p = stripConferencePhrases(p);
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
  const stripped = stripUnspeakableTokens(source);

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
