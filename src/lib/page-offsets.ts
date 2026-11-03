/**
 * Map PDF page boundaries into a text that was rewritten after unwrapping.
 *
 * `unwrapPdfPagesDetailed` already reports the exact character offset of
 * every page in the string it returns. `normalizeExtractedText` then runs over
 * that string and may drop page markers or collapse blank lines, which shifts
 * those offsets. Re-deriving the boundaries by searching a 48-character probe
 * lost whole books: the probe kept the unwrapped spaces, the rewritten text
 * had paragraph breaks in their place, `indexOf` failed, and every later page
 * collapsed onto the same cursor (all-zero page starts).
 *
 * This keeps the exact offsets as the source of truth and only *adjusts* them,
 * matching whitespace-insensitively and searching outward from where the page
 * is expected to be.
 */

/** How far a page may slide from its unwrapped offset, in characters. */
const SEARCH_SLACK = 4_000;
/** Enough of a page to identify it, after whitespace is removed. */
const ANCHOR_CHARS = 40;

type Stripped = { text: string; map: number[] };

function stripWhitespace(text: string): Stripped {
  let out = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) continue;
    out += ch;
    map.push(i);
  }
  return { text: out, map };
}

function strippedIndexAt(original: number, stripped: string, map: number[]): number {
  // First stripped position whose source offset is at or after `original`.
  let lo = 0;
  let hi = map.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (map[mid]! < original) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, stripped.length);
}

/**
 * Offsets of each page in `text`.
 *
 * `expected[i]` is the exact offset measured before the rewrite. `probes[i]`
 * is that page's leading text, used only to re-anchor when the rewrite moved
 * it. A page whose anchor cannot be found keeps its adjusted expected offset,
 * so the array stays ordered and every index still names a real page.
 */
export function relocatePageStarts(
  text: string,
  probes: string[],
  expected: number[]
): number[] {
  if (probes.length === 0) return [];
  const stripped = stripWhitespace(text);
  const out: number[] = [];
  let cursor = 0;

  for (let i = 0; i < probes.length; i++) {
    const guess = expected[i];
    const anchored =
      typeof guess === "number" && Number.isInteger(guess) && guess >= 0 && guess <= text.length
        ? guess
        : cursor;
    const from = Math.max(cursor, anchored - SEARCH_SLACK);
    const anchor = stripWhitespace(probes[i] ?? "").text.slice(0, ANCHOR_CHARS);

    let offset: number | null = null;
    if (anchor.length >= 16) {
      const start = strippedIndexAt(from, stripped.text, stripped.map);
      const at = stripped.text.indexOf(anchor, start);
      if (at >= 0) offset = stripped.map[at] ?? null;
    }
    // Never behind the previous page, and always inside the text.
    const resolved = Math.min(Math.max(offset ?? anchored, cursor), text.length);
    out.push(resolved);
    cursor = resolved;
  }
  return out;
}

/** True when every offset is a non-decreasing index inside `text`. */
export function pageStartsUsable(starts: number[] | undefined, length: number): boolean {
  if (!starts || starts.length === 0) return false;
  let previous = -1;
  for (const start of starts) {
    if (!Number.isInteger(start) || start < 0 || start > length) return false;
    if (start < previous) return false;
    previous = start;
  }
  return true;
}
