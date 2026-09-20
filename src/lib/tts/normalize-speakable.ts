/**
 * General PDF / OCR / markup hygiene before TTS.
 *
 * This is not an oral rewrite and has no essay- or voice-specific word lists.
 * Academic cover peeling still lives in `toSpeakableText` (it needs footnote
 * marks to detect author lines). Call this *after* that peel, or on already
 * clean prose.
 */

const FISH_EMOTION_CUES = [
  "whispering",
  "sighing",
  "excited",
  "sad",
  "slightly sad",
  "angry",
  "happy",
  "surprised",
  "nervous",
  "calm",
] as const;

export const FISH_PAUSE_CUES = new Set([
  "break",
  "long-break",
  "long pause",
  "conversational seminar tone",
  ...FISH_EMOTION_CUES,
]);

const FISH_FREEFORM_CUE_RE =
  /^(?:slightly\s+)?[a-z][a-z\s-]{0,40}$/;

const EDITORIAL_BRACKET_RE = /\b(like this|sic|emphasis|ed\.|cite)\b/;

const FOOTNOTE_MARKS = String.raw`[*∗†‡§]`;
const ROMAN_LINE_RE =
  /^(?=[IVXLCDM]+$)(?!$)M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})\.?$/i;

function collapseInlineWs(s: string): string {
  return s.replace(/[^\S\n]+/g, " ").replace(/[ \t]+\n/g, "\n").trim();
}

function isPreservedFishCue(inner: string): boolean {
  const t = inner.trim().toLowerCase();
  if (FISH_PAUSE_CUES.has(t)) return true;
  if (EDITORIAL_BRACKET_RE.test(t)) return false;
  if (t.length >= 3 && t.length <= 48 && FISH_FREEFORM_CUE_RE.test(t)) {
    return !/^\d/.test(t);
  }
  return false;
}

function isNumericCitation(inner: string): boolean {
  return /^\d+(?:\s*[-–,]\s*\d+)*$/.test(inner.trim());
}

function rewriteBrackets(text: string): string {
  return text.replace(/\[([^\[\]]+)\]/g, (full, inner: string) => {
    if (isPreservedFishCue(inner)) return full;
    if (isNumericCitation(inner)) return "";
    return inner.trim();
  });
}

function stripFootnoteMarkers(text: string): string {
  return text
    .replace(new RegExp(`${FOOTNOTE_MARKS}+(?=\\s|[.,;:!?]|$)`, "gu"), "")
    .replace(new RegExp(`(${FOOTNOTE_MARKS}){2,}`, "gu"), "");
}

export function isAllCapsTitleLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (!/\p{L}/u.test(t)) return false;
  if (/\p{Ll}/u.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  const letters = (t.match(/\p{L}/gu) || []).length;
  if (words.length >= 2 && letters >= 4) return true;
  if (words.length === 1 && letters >= 5) return true;
  return false;
}

function toTitleCase(line: string): string {
  return line
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((word) =>
      word ? word.charAt(0).toUpperCase() + word.slice(1) : word
    )
    .join(" ");
}

export function isRomanSectionLine(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 15) return false;
  return ROMAN_LINE_RE.test(t);
}

/**
 * Prepare messy extracted text for a narrator: strip spoken footnote junk,
 * unwrap editorial brackets, Title-Case ALL-CAPS headings, drop lone Roman
 * section numerals, and collapse whitespace while keeping paragraphs.
 */
export function normalizeSpeakableText(
  text: string,
  opts?: { normalizeTitles?: boolean }
): string {
  if (!text || !text.trim()) return "";

  const source = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const paragraphs = source
    .split(/\n\s*\n/)
    .map((block) => {
      const line = collapseInlineWs(block.replace(/\n/g, " "));
      if (!line) return "";
      if (isRomanSectionLine(line)) {
        return `Chapter ${line.trim().replace(/\.$/, "")}`;
      }
      let next = rewriteBrackets(line);
      next = stripFootnoteMarkers(next);
      next = collapseInlineWs(next);
      if (!next) return "";
      if (isRomanSectionLine(next)) {
        return `Chapter ${next.replace(/\.$/, "")}`;
      }
      if (opts?.normalizeTitles !== false && isAllCapsTitleLine(next)) {
        return toTitleCase(next);
      }
      return next.replace(/\s+([.,;:!?])/g, "$1");
    })
    .filter(Boolean);

  return paragraphs.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}
