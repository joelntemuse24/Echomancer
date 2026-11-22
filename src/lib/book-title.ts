/**
 * The title a book gets when the person does not type one.
 *
 * An uploaded document carries its file name, and file names are written for
 * a filesystem, not for reading: `the_hobbit_-_tolkien.pdf`. Shown as-is the
 * title kept the underscores, the extension, and the lowercase slug. This
 * turns that into `The Hobbit - Tolkien` at the display boundary, so every
 * surface (voice step, library, player, download, Media Session) and the
 * stored `jobs.book_title` agree.
 *
 * It stays conservative. A name that already reads like a title comes back
 * unchanged, and a title the person typed or a fetched page title (spaces,
 * no underscores, no extension) is only trimmed.
 */

/** Extensions the document intake and the text intake can hand us. */
const DOCUMENT_EXTENSION =
  /\.(?:pdf|epub|docx?|txt|text|rtf|mobi|azw|azw3|azw4|html?|xhtml|md|markdown|djvu)$/i;

export const UNTITLED_BOOK_TITLE = "Untitled";

const MAX_TITLE_CHARS = 200;

/** Words a title keeps lowercase unless they start or end it. */
const SMALL_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "but",
  "by",
  "for",
  "from",
  "in",
  "into",
  "nor",
  "of",
  "on",
  "or",
  "over",
  "per",
  "the",
  "to",
  "up",
  "via",
  "vs",
  "with",
]);

const ROMAN_NUMERAL_RE =
  /^M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/;

/**
 * A word that is letters rather than a word. Only a known initialism is
 * re-uppercased: guessing from shape turned `my` into `MY`, and a title is
 * worse than the slug when a guess is wrong.
 */
const KNOWN_INITIALISMS = new Set([
  "AI", "API", "BBC", "CIA", "CPU", "DNA", "EU", "FBI", "FAQ", "GPU",
  "HTML", "IBM", "ISBN", "LLC", "LTD", "MIT", "NASA", "NATO", "NBA", "NFL",
  "NHS", "NIH", "NPR", "NYC", "PDF", "PhD", "RAF", "RSS", "SQL", "TUC",
  "TV", "UAE", "UK", "UN", "UNESCO", "UNICEF", "URL", "US", "USA", "USSR",
  "VAT", "VPN", "WHO", "WTO", "WWF", "XML",
]);

function isInitialism(word: string): boolean {
  return KNOWN_INITIALISMS.has(word);
}

/** `CHAPTER II` → `Chapter II`; `pride and prejudice` → `Pride and Prejudice`. */
function titleCaseWords(value: string): string {
  const words = value.split(" ");
  return words
    .map((word, index) => {
      if (isInitialism(word)) return word;
      const lower = word.toLowerCase();
      // Keep leading punctuation and a trailing mark ("(draft)", "End.").
      const leading = /^["'“‘([{]*/.exec(lower)?.[0] ?? "";
      const trailing = /["'”’)\]}.!?,;:]*$/.exec(lower)?.[0] ?? "";
      const bare = lower.slice(
        leading.length,
        lower.length - trailing.length
      );
      if (!bare) return word;
      const upper = bare.toUpperCase();
      if (ROMAN_NUMERAL_RE.test(upper)) {
        return leading + upper + trailing;
      }
      if (isInitialism(upper)) {
        return leading + upper + trailing;
      }
      const first = index === 0;
      const last = index === words.length - 1;
      if (!first && !last && SMALL_WORDS.has(bare)) {
        return leading + bare + trailing;
      }
      // A dotted initial keeps its shape and capitalises every part:
      // `j.r.r` → `J.R.R`.
      const capitalised = /^[a-z](?:\.[a-z])+\.?$/.test(bare)
        ? bare.replace(/[a-z]/g, (letter) => letter.toUpperCase())
        : bare.charAt(0).toUpperCase() + bare.slice(1);
      return leading + capitalised + trailing;
    })
    .join(" ");
}

/** Cut on a word boundary so a long name does not end mid-word. */
function capTitle(value: string): string {
  if (value.length <= MAX_TITLE_CHARS) return value;
  const cut = value.slice(0, MAX_TITLE_CHARS);
  const atSpace = cut.lastIndexOf(" ");
  return (atSpace >= 24 ? cut.slice(0, atSpace) : cut).trim();
}

/** A name that still carries a document extension is a file name, not a title. */
export function looksLikeFileName(value: string | null | undefined): boolean {
  return DOCUMENT_EXTENSION.test((value ?? "").trim());
}

/**
 * A file name turned into a readable book title.
 *
 * - the document extension and any directory part are dropped
 * - `_` runs become spaces, and repeated dashes become a ` - ` separator
 * - a name with no capital at all has its glued hyphens split (`the-hobbit`)
 * - `PRIDE_AND_PREJUDICE` is title-cased, Roman numerals and initialisms kept
 * - anything with no readable words becomes `Untitled`
 *
 * A typed title ("Quay notes") only gets trimmed: it never had a file name's
 * separators, so there is nothing to undo.
 */
export function bookTitleFromFileName(
  raw: string | null | undefined
): string {
  const original = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!original) return UNTITLED_BOOK_TITLE;

  const hadExtension = looksLikeFileName(original);
  let name = hadExtension
    ? original.replace(DOCUMENT_EXTENSION, "").trim()
    : original;
  // A Drive or command-line handoff can carry a path. A separator with no
  // spaces in the name means the whole thing came from a file system.
  const fromPath = /[\\/]/.test(name) && !/\s/.test(name);
  if (fromPath) {
    name = name.split(/[\\/]+/).pop() || name;
  }
  const fileLike = hadExtension || fromPath || /_/.test(name);

  let title = name
    .replace(/_+/g, " ")
    .replace(/\s*-{2,}\s*/g, " - ")
    .replace(/^[-–—\s]+|[-–—\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) return UNTITLED_BOOK_TITLE;

  // A slug glues its words with hyphens and has no capital to protect, so
  // `the-hobbit` splits while `Spider-Man` keeps its hyphen.
  if (!/\p{Lu}/u.test(title)) {
    title = title.replace(/(\p{Ll})-(?=\p{Ll})/gu, "$1 ");
    title = title.replace(/\s+/g, " ").trim();
  }

  const words = title.split(" ");
  // Only a name that looked like a file name is re-cased. `THE_HOBBIT.pdf`
  // and `pride_and_prejudice` are file names, while a typed all-caps title
  // ("UPITN 13 6 73 END OF LECTURE") reads as written and is left alone.
  const allCaps = words.length > 1 && !/\p{Ll}/u.test(title);
  const allLower = !/\p{Lu}/u.test(title);
  if (fileLike && (allCaps || allLower)) {
    title = titleCaseWords(title);
  }
  if (title.replace(/[^\p{L}\p{N}]/gu, "").length < 2) {
    return UNTITLED_BOOK_TITLE;
  }
  return capTitle(title);
}

/**
 * A stored book title with file-name junk taken out of it.
 *
 * A rename or a typed title is left exactly as the person wrote it: none of
 * them carry an underscore or a document extension, because a person types
 * spaces. A value that does carry one is a file name an older client stored,
 * and it is rewritten once, on the way out.
 */
export function normalizeStoredBookTitle(
  raw: string | null | undefined
): string {
  const value = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!value) return value;
  const fileLike = looksLikeFileName(value) || value.includes("_");
  return fileLike ? bookTitleFromFileName(value) : value;
}

/**
 * The title to build a download's file name from. An untitled book has no
 * words to use, so the caller's own fallback ("audiobook") applies.
 */
export function titleForDownload(raw: string | null | undefined): string {
  const title = normalizeStoredBookTitle(raw);
  return title === UNTITLED_BOOK_TITLE ? "" : title;
}

/**
 * Type scale for a book title heading. A phone cannot hold a 200-character
 * title at display size, so the size steps down with the length instead of
 * letting the heading run off the screen or push the transport below it.
 */
export function bookTitleHeadingClass(
  title: string | null | undefined
): string {
  const length = (title ?? "").replace(/\s+/g, " ").trim().length;
  if (length <= 34) return "text-4xl md:text-5xl";
  if (length <= 72) return "text-3xl md:text-4xl lg:text-5xl";
  if (length <= 120) return "text-2xl md:text-3xl lg:text-4xl";
  return "text-xl md:text-2xl lg:text-4xl";
}
