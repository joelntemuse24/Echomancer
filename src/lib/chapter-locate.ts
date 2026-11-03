/**
 * Locate a chapter's opening words in the narration text.
 *
 * Used by the player to time a chapter marker when the stored offset has drifted
 * (`playback-chapters.ts`). It is deliberately tolerant — exact, then
 * whitespace/punctuation/case-insensitive, then a small fuzzy match — because a
 * stored `match` line may have been lightly cleaned.
 */

export type FoldedText = {
  folded: string;
  /** Original char offset for each folded char. */
  map: number[];
  words: { word: string; foldedStart: number }[];
  byWord: Map<string, number[]>;
};

function foldChar(ch: string): string | null {
  if (/[\p{L}\p{N}]/u.test(ch)) return ch.toLowerCase();
  if (/\s/u.test(ch)) return " ";
  return " ";
}

/** Lowercase, punctuation- and whitespace-insensitive fold with offset map. */
function foldForLocate(text: string, base = 0): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < text.length; i++) {
    const out = foldChar(text[i]!);
    if (out === " ") {
      if (folded.length > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      folded += " ";
      map.push(base + i);
      pendingSpace = false;
    }
    folded += out;
    map.push(base + i);
  }
  return { folded: folded.replace(/ +$/g, ""), map };
}

export function buildFoldedCache(text: string): FoldedText {
  const { folded, map } = foldForLocate(text);
  const words: { word: string; foldedStart: number }[] = [];
  const byWord = new Map<string, number[]>();
  const re = /[^ ]+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(folded))) {
    const index = words.length;
    words.push({ word: match[0], foldedStart: match.index });
    const list = byWord.get(match[0]) ?? [];
    list.push(index);
    byWord.set(match[0], list);
  }
  return { folded, map, words, byWord };
}

function foldedIndexForChar(cache: FoldedText, charOffset: number): number {
  let lo = 0;
  let hi = cache.map.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cache.map[mid]! < charOffset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function wordIndexForFolded(cache: FoldedText, foldedIndex: number): number {
  let lo = 0;
  let hi = cache.words.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cache.words[mid]!.foldedStart < foldedIndex) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Small fuzzy match for a slightly mis-copied opening: substitution-only
 * word overlap of 80%+ over at least 5 words, anchored on distinctive words.
 * Returns the original char offset, or -1.
 */
export function fuzzyLocateOpening(
  cache: FoldedText,
  openingWords: string[],
  fromChar: number
): number {
  const wanted = openingWords.map((word) => word.toLowerCase()).filter(Boolean);
  if (wanted.length < 5) return -1;
  const fromWord = Math.max(
    0,
    wordIndexForFolded(cache, foldedIndexForChar(cache, Math.max(0, fromChar))) - 2
  );
  const distinctive = wanted
    .map((word, i) => ({ word, i }))
    .filter((entry) => entry.word.length >= 5)
    .slice(0, 3);
  const seeds = distinctive.length > 0 ? distinctive : wanted.map((word, i) => ({ word, i }));
  const candidates = new Set<number>();
  for (const seed of seeds) {
    const occurrences = cache.byWord.get(seed.word) ?? [];
    for (const at of occurrences) {
      const start = at - seed.i;
      if (start < fromWord) continue;
      if (start + wanted.length > cache.words.length) continue;
      candidates.add(start);
      if (candidates.size >= 40) break;
    }
    if (candidates.size >= 40) break;
  }
  let best = -1;
  let bestScore = 0;
  for (const start of candidates) {
    let hits = 0;
    for (let j = 0; j < wanted.length; j++) {
      if (cache.words[start + j]!.word === wanted[j]) hits += 1;
    }
    const score = hits / wanted.length;
    if (score > bestScore && score >= 0.8) {
      bestScore = score;
      best = start;
    }
  }
  if (best < 0) return -1;
  const foldedStart = cache.words[best]!.foldedStart;
  return cache.map[foldedStart] ?? -1;
}

/**
 * Locate verbatim opening words in the text: exact first, then a
 * whitespace/punctuation/case-insensitive match, then a small fuzzy match.
 * Searches forward from `from`. Returns the char offset, or -1.
 */
export function locateOpeningWords(
  text: string,
  opening: string,
  from = 0,
  cache?: FoldedText
): number {
  const start = Math.max(0, Math.min(text.length, from));
  const needle = opening.replace(/\s+/g, " ").trim();
  if (needle.length < 3) return -1;
  const exact = text.indexOf(needle, start);
  if (exact >= 0) return exact;
  const folded = cache ?? buildFoldedCache(text);
  const { folded: wantFolded } = foldForLocate(needle);
  if (wantFolded.length >= 3) {
    const fromFolded = foldedIndexForChar(folded, start);
    const at = folded.folded.indexOf(wantFolded, fromFolded);
    if (at >= 0) {
      const pos = folded.map[at];
      if (pos != null) return pos;
    }
  }
  return fuzzyLocateOpening(folded, wantFolded.split(" "), start);
}
