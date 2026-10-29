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

/**
 * Acronyms and initialisms that must survive Title Case: a news or technical
 * paragraph in caps is full of them, and "NOAA" becoming "Noaa" is wrong in a
 * way a listener hears immediately.
 */
const KEEP_CAPS = new Set([
  "AI", "AP", "BBC", "BLS", "CBO", "CDC", "CEO", "CIA", "CNN", "DOJ", "DWP",
  "EEOC", "EPA", "EU", "FBI", "FDA", "FDIC", "FEMA", "GAO", "GDP", "GPU", "HHS",
  "HMS", "HMRC", "HUD", "IBM", "IMF", "IRS", "ISBN", "ITU", "JFK", "LLC", "LTD",
  "MIT", "MLB", "NASA", "NATO", "NBA", "NFL", "NHS", "NIH", "NIST", "NOAA",
  "NPR", "NSA", "NSW", "NYC", "OBE", "OECD", "OPEC", "OSHA", "PBS", "PDF",
  "PLO", "QMUL", "RAC", "RAF", "RBI", "RSPB", "RSS", "SEIU", "SFO", "SQL",
  "SSN", "TUC", "UAE", "UCLA", "UK", "UN", "UNESCO", "UNICEF", "US", "USA",
  "USAID", "USDA", "USGS", "USSR", "VAT", "VPN", "WHO", "WMO", "WTO", "WWF",
  "YMCA", "YWCA", "AA", "AAA", "AAU", "ACLU", "AFL", "AFT", "ASCAP", "ASPCA",
  "BC", "AD", "AM", "PM", "OK", "TV", "ID", "PC", "PR", "HR", "IT", "UKIP",
]);

/** Keep an all-caps token that reads as an initialism rather than a word. */
function preserveCapsWord(word: string): boolean {
  const core = word.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
  if (core.length === 0) return false;
  if (KEEP_CAPS.has(core)) return true;
  // Two or three letters with no vowels (or a trailing plural s) read as
  // letters: "FBI", "NHS", "MPs". "THE" and "AND" must not qualify.
  if (/^[A-Z]{2,3}S?$/.test(core) && !/[AEIOU]/.test(core.replace(/S$/, ""))) return true;
  return false;
}

/**
 * A standalone all-caps line is a heading only when it reads like a title.
 * A shouted sentence ("THE STORM HAS PASSED…"), an all-caps body paragraph,
 * and a line of initialisms are not titles, and title-casing them destroys
 * acronyms.
 */
export function isAllCapsTitleLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (!/\p{L}/u.test(t)) return false;
  if (/\p{Ll}/u.test(t)) return false;
  // A heading does not trail off with a comma or exclamation. A single token
  // may end with a period ("CHAPTERXXVII." is a glued chapter label).
  if (/[,;:]$/.test(t) || /[!?…]["”’)\]]*$/.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  const letters = (t.match(/\p{L}/gu) || []).length;
  if (words.length === 1 && letters >= 5) return true;
  if (/\.$/.test(t)) return false;
  // A title is short. A paragraph of caps is body text or shouting.
  if (words.length < 2 || words.length > 8) return false;
  // At least half the words must be genuine title words, not initialisms.
  const titleWords = words.filter((word) => {
    const core = word.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
    return core.length >= 2 && !preserveCapsWord(word);
  }).length;
  return letters >= 4 && titleWords >= Math.ceil(words.length / 2);
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
      // Restore any initialism this line contains: "Noaa" is wrong.
      if (core.length > 0 && KEEP_CAPS.has(core.toUpperCase())) {
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

/** A markdown table alignment row: pipes, dashes, colons, spaces only. */
/** A markdown table alignment row: pipes plus dashes/colons, and at least one pipe. */
const TABLE_RULE_RE = /^(?=.*\|)[\s|:-]+$/;
/** A bullet marker is markup; a numeral is spoken, so it stays. */
const BULLET_ITEM_RE = /^\s*[-*•·–—]\s+(.+)$/;
const NUMBERED_ITEM_RE = /^\s*(\d{1,3}[.)])\s+(.+)$/;

/**
 * Markdown and HTML lists keep one newline per item, so a blank-line join
 * turns a list into a single run-on sentence and the narrator reads the bullet
 * character aloud. A table is worse: the pipe characters and the alignment
 * row are read out.
 *
 * Every list item and table row becomes its own paragraph. A bullet marker is
 * dropped; a list numeral is kept so it is spoken as an ordinal. `splitSentences`
 * and section packing then treat each item as independent text.
 */
export function flattenListsAndTables(text: string): string {
  if (!text) return "";
  const source = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const out: string[] = [];
  let previousWasItem = false;

  const startItem = () => {
    // An item is its own paragraph, so packing cannot fuse two entries.
    if (!previousWasItem && out.length > 0 && out[out.length - 1] !== "") out.push("");
  };

  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line) {
      out.push("");
      previousWasItem = false;
      continue;
    }
    // "|---|---|" and "| --- | :-- |" are alignment, not content.
    if (TABLE_RULE_RE.test(line)) continue;

    if (line.startsWith("|") || (line.match(/\|/g)?.length ?? 0) >= 2) {
      const cells = line
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean);
      if (cells.length === 0) continue;
      startItem();
      // A blank line after the item keeps it from being joined to the next.
      out.push(cells.join(", "), "");
      previousWasItem = true;
      continue;
    }

    const numbered = NUMBERED_ITEM_RE.exec(line);
    if (numbered) {
      startItem();
      out.push(`${numbered[1]} ${numbered[2]!.trim()}`, "");
      previousWasItem = true;
      continue;
    }

    const bullet = BULLET_ITEM_RE.exec(line);
    if (bullet) {
      startItem();
      out.push(bullet[1]!.trim(), "");
      previousWasItem = true;
      continue;
    }

    out.push(raw.trimEnd());
    previousWasItem = false;
  }

  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
  out = out.replace(
    /([$£€])((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(million|billion|m|b)\b/gi,
    (_, symbol: string, raw: string, scale: string) => {
      // "$4.2 million" is four point two million dollars. Treating the ".2"
      // as cents produced "four dollars and twenty cents million".
      const names = symbol === "$" ? ["dollar", "cent"] : symbol === "£" ? ["pound", "penny"] : ["euro", "cent"];
      const magnitude = /^m/i.test(scale) ? "million" : "billion";
      const value = spokenNumber(raw);
      const plural = /^one$/.test(value) ? "" : "s";
      return `${value} ${magnitude} ${names[0]}${plural}`;
    });
  out = out.replace(/([$£€])((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\b/gi,
    (_, symbol: string, raw: string) => {
      const names = symbol === "$" ? ["dollar", "cent"] : symbol === "£" ? ["pound", "penny"] : ["euro", "cent"];
      const [whole, fraction] = raw.replace(/,/g, "").split(".");
      const cents = Number((fraction ?? "").padEnd(2, "0"));
      if (fraction && fraction.length <= 2) {
        const minor = cents === 1 ? names[1] : symbol === "£" ? "pence" : `${names[1]}s`;
        return `${cardinal(Number(whole))} ${names[0]}${Number(whole) === 1 ? "" : "s"}${cents ? ` and ${cardinal(cents)} ${minor}` : ""}`;
      }
      return `${spokenNumber(raw)} ${names[0]}${Number(whole) === 1 ? "" : "s"}`;
    });
  // A decade is spoken as a decade: "the 1990s" is the nineteen nineties.
  // Runs before the bare-number pass, which would otherwise read "1990".
  out = out.replace(/\b(\d{2})(\d0)s\b/g, (raw, century: string, decade: string) => {
    const tens = Number(century);
    const tensWord = ["", "ten", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"][Number(decade[0])];
    const decadeWord = tensWord!.endsWith("y") ? `${tensWord!.slice(0, -1)}ies` : `${tensWord}s`;
    if (tens >= 10 && tens <= 19) return decade === "00" ? "nineteen hundreds" : `nineteen ${decadeWord}`;
    if (tens === 20) return decade === "00" ? "two thousands" : `twenty ${decadeWord}`;
    return raw;
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
    // "N+1", "v2", "H.264", "3/4" and "C-130" are code, versions and
    // designators. Speaking "N+one" mixes a letter with a number mid-token.
    if (/[A-Za-z_+\-/.#$]$/.test(before) || /^[A-Za-z_+\-/]/.test(after)) return raw;
    const quantity = /\b(?:number|page|pages|chapter|part|room|item|total|of)\s+$/i.test(before) ||
      /^\s+(?:people|items|dollars|pounds|euros|meters|metres|miles|soldiers|units|books)\b/i.test(after);
    return spokenNumber(raw, !quantity && /^\d{4}$/.test(raw));
  });
  return out;
}
