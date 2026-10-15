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

const STRICT_ROMAN_WORD_RE =
  /^M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/;

/** "CHAPTER II" becomes "Chapter II", never "Chapter Ii". */
export function toTitleCase(line: string): string {
  return line
    .trim()
    .toLowerCase()
    .split(/(\s+)/)
    .map((part) => {
      if (!part.trim()) return part;
      const word = part.charAt(0).toUpperCase() + part.slice(1);
      const core = word.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
      if (core.length > 0 && STRICT_ROMAN_WORD_RE.test(core.toUpperCase())) {
        return word.replace(core, core.toUpperCase());
      }
      return word;
    })
    .join("");
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
      if (isRomanSectionLine(line) && line.trim().replace(/\.$/, "").length > 1) {
        return `Chapter ${line.trim().replace(/\.$/, "")}`;
      }
      let next = rewriteBrackets(line);
      next = stripFootnoteMarkers(next);
      next = collapseInlineWs(next);
      if (!next) return "";
      if (isRomanSectionLine(next) && next.replace(/\.$/, "").length > 1) {
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

const SMALL = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function cardinal(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) return String(n);
  if (n < 20) return SMALL[n]!;
  if (n < 100) return TENS[Math.floor(n / 10)]! + (n % 10 ? `-${cardinal(n % 10)}` : "");
  for (const [size, name] of [[1e12, "trillion"], [1e9, "billion"], [1e6, "million"], [1000, "thousand"], [100, "hundred"]] as const) {
    if (n >= size) return `${cardinal(Math.floor(n / size))} ${name}${n % size ? ` ${cardinal(n % size)}` : ""}`;
  }
  return String(n);
}

function ordinal(n: number): string {
  const irregular: Record<string, string> = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };
  return cardinal(n).replace(/[a-z]+$/, (word) => irregular[word] ?? (word.endsWith("y") ? `${word.slice(0, -1)}ieth` : `${word}th`));
}

function spokenNumber(raw: string, year = false): string {
  const clean = raw.replace(/,/g, "");
  if (clean.includes(".")) {
    const [whole, fraction] = clean.split(".");
    return `${cardinal(Number(whole))} point ${fraction!.split("").map((digit) => SMALL[Number(digit)]).join(" ")}`;
  }
  const n = Number(clean);
  if (!Number.isSafeInteger(n)) return raw;
  if (year && n >= 1100 && n <= 1999) {
    return `${cardinal(Math.floor(n / 100))} ${n % 100 === 0 ? "hundred" : n % 100 < 10 ? `oh ${cardinal(n % 100)}` : cardinal(n % 100)}`;
  }
  return cardinal(n);
}

function romanNumber(roman: string): number {
  const values: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  return [...roman].reduce((sum, letter, i) => sum + (values[letter]! < (values[roman[i + 1]!] ?? 0) ? -values[letter]! : values[letter]!), 0);
}

/** English backstop for a missing or failed LLM cleanup result. */
export function normalizeNumbersAndAbbreviations(text: string): string {
  let out = text.replace(/\b(e\.g\.|i\.e\.|etc\.|vs\.)/gi, (raw) => ({
    "e.g.": "for example", "i.e.": "that is", "etc.": "et cetera", "vs.": "versus",
  })[raw.toLowerCase()]!);
  out = out.replace(/\b(Mr|Mrs|Dr|Gen|Col|Capt)\./g, (_, title: string) => ({
    Mr: "Mister", Mrs: "Missus", Dr: "Doctor", Gen: "General", Col: "Colonel", Capt: "Captain",
  })[title]!);
  out = out.replace(/\bSt\./g, (raw, offset: number) => {
    const before = out.slice(0, offset);
    const after = out.slice(offset + raw.length);
    if (/\b\d+\s+[\p{L} '-]+\s$/u.test(before) || !/^\s+[A-Z][a-z]/.test(after)) return "Street";
    return "Saint";
  });
  const months: Record<string, string> = {
    Jan: "January", Feb: "February", Mar: "March", Apr: "April", May: "May", Jun: "June",
    Jul: "July", Aug: "August", Sep: "September", Sept: "September", Oct: "October", Nov: "November", Dec: "December",
  };
  out = out.replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.(?=\s+\d)/g, (_, month: string) => months[month]!);
  out = out.replace(/\bNo\.(?=\s*\d)/g, "Number");
  out = out.replace(/\b(Chapter|Part|Book|Volume|Act|Section|George|Henry|Edward|Louis|Charles|Elizabeth|James|William|Victoria|Pope\s+[A-Z][a-z]+)\s+([IVXLCDM]+)\b/g,
    (raw, title: string, roman: string) => {
      if (!STRICT_ROMAN_WORD_RE.test(roman)) return raw;
      const n = romanNumber(roman);
      return /^(Chapter|Part|Book|Volume|Act|Section)$/.test(title) ? `${title} ${cardinal(n)}` : `${title} the ${ordinal(n)}`;
    });
  out = out.replace(/\b([IVXLCDM]+)(?=\s+century\b)/g, (raw) =>
    STRICT_ROMAN_WORD_RE.test(raw) ? ordinal(romanNumber(raw)) : raw);
  out = out.replace(/([$£€])((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)([mb])?\b/gi,
    (_, symbol: string, raw: string, scale?: string) => {
      const names = symbol === "$" ? ["dollar", "cent"] : symbol === "£" ? ["pound", "penny"] : ["euro", "cent"];
      if (scale) return `${spokenNumber(raw)} ${scale.toLowerCase() === "m" ? "million" : "billion"} ${names[0]}s`;
      const [whole, fraction] = raw.replace(/,/g, "").split(".");
      const cents = Number((fraction ?? "").padEnd(2, "0"));
      if (fraction && fraction.length <= 2) {
        const minor = cents === 1 ? names[1] : symbol === "£" ? "pence" : `${names[1]}s`;
        return `${cardinal(Number(whole))} ${names[0]}${Number(whole) === 1 ? "" : "s"}${cents ? ` and ${cardinal(cents)} ${minor}` : ""}`;
      }
      return `${spokenNumber(raw)} ${names[0]}${Number(whole) === 1 ? "" : "s"}`;
    });
  out = out.replace(/\b((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*%/g, (_, n: string) => `${spokenNumber(n)} percent`);
  out = out.replace(/\b(\d+)(?:st|nd|rd|th)\b/gi, (_, n: string) => ordinal(Number(n)));
  out = out.replace(/\b(\d{4})[-–](\d{2}|\d{4})\b/g, (_, from: string, to: string) => {
    const end = to.length === 2 ? from.slice(0, 2) + to : to;
    return `${spokenNumber(from, true)} to ${spokenNumber(end, true)}`;
  });
  out = out.replace(/\bpp?\.\s*(\d+)\s*[-–]\s*(\d+)\b/g, (_, from: string, to: string) => `pages ${spokenNumber(from)} to ${spokenNumber(to)}`);
  out = out.replace(/\b(\d+)\s*[-–]\s*(\d+)\b/g, (_, from: string, to: string) => `${spokenNumber(from)} to ${spokenNumber(to)}`);
  // Explicit quantities keep cardinal speech; four-digit dates use year speech.
  out = out.replace(/\b(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\b/g, (raw, offset: number) => {
    const before = out.slice(0, offset);
    const after = out.slice(offset + raw.length);
    const quantity = /\b(?:number|page|pages|chapter|part|room|item|total|of)\s+$/i.test(before) ||
      /^\s+(?:people|items|dollars|pounds|euros|meters|metres|miles|soldiers|units|books)\b/i.test(after);
    return spokenNumber(raw, !quantity && /^\d{4}$/.test(raw));
  });
  return out;
}
