/**
 * Blocks → speakable text, with the block offsets recorded once.
 *
 * This is the only place a block's character offset is decided. Chapter
 * markers are block indexes; a marker's `charStart` is `blockStart[i]`, so
 * nothing has to search the prose afterwards.
 *
 * The narration string itself is produced by the *same* whole-document pass
 * every other source uses (`normalizeSourceText` then `toSpeakableText`). Only
 * the offsets are derived here, by locating each block's words in that string
 * in order. Cleaning moves whitespace, so the locate is whitespace-insensitive
 * and advances a cursor; a block whose words the narrator dropped keeps -1.
 */

import type { BookBlock } from "@/lib/blocks";
import { toSpeakableText } from "@/lib/tts/speakable-text";
import { normalizeSourceText } from "@/lib/source-text";

export type SpeakableProjection = {
  /** The narration string. */
  text: string;
  /** Char offset of each source block in `text`, or -1 when it carried no words. */
  blockStart: number[];
};

/** The one paragraph pass, applied to the whole block list at once. */
export function blocksToSourceText(blocks: BookBlock[]): string {
  return normalizeSourceText(
    blocks
      .map((block) => block.text.replace(/[^\S\n]+/g, " ").trim())
      .filter(Boolean)
      .join("\n\n")
  );
}

/**
 * Fold a string to letters, digits, and single spaces, keeping a map back to
 * the original offsets. Case and punctuation are dropped, so "Mr. Darcy's" and
 * "mr darcys" fold to the same thing.
 */
function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/[\p{L}\p{N}]/u.test(ch)) {
      if (pendingSpace && folded.length > 0) {
        folded += " ";
        map.push(i);
      }
      pendingSpace = false;
      folded += ch.toLowerCase();
      map.push(i);
      continue;
    }
    if (/\s/u.test(ch) || /[\p{P}\p{S}]/u.test(ch)) pendingSpace = true;
  }
  return { folded, map };
}

/**
 * Locate each block in the narration string, in order.
 *
 * A block is found by folding it and searching forward from the previous
 * block's hit. Cleaning can merge or split paragraphs, so a miss is not fatal:
 * the cursor stays put and the block keeps -1 unless a shorter prefix of it
 * can still be found.
 */
/**
 * How much longer than a block's own folded text the matching region may be.
 *
 * Cleaning rewrites a paragraph (links, glued words, symbols) and can drop one
 * entirely, so the cursor and the block list can drift apart by a little. It
 * cannot drift by a lot: a block is found near where the previous one ended, and
 * a match outside that window is a coincidence, not the block.
 */
const LOCATE_SLACK_CHARS = 400;
/** Longest folded lead tried for a block the narrator rewrote. */
const MAX_LEAD_WORDS = 12;

export function locateBlockStarts(text: string, blocks: BookBlock[]): number[] {
  const { folded, map } = foldWithMap(text);
  const starts = new Array<number>(blocks.length).fill(-1);
  let cursor = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const needle = foldWithMap(block.text).folded;
    if (!needle) continue;
    // The window a block may be found in. A block the narrator dropped simply
    // does not match here, and the cursor stays put for the next one.
    const limit = Math.min(folded.length, cursor + needle.length * 2 + LOCATE_SLACK_CHARS);
    let at = indexWithin(folded, needle, cursor, limit);
    let end = at >= 0 ? at + needle.length : -1;
    if (at < 0) {
      // A block the narrator rewrote is still worth finding: its first few
      // words usually survive, and a chapter start is only needed once.
      const words = needle.split(" ");
      for (let take = Math.min(words.length - 1, MAX_LEAD_WORDS); take >= 1; take -= 1) {
        const lead = words.slice(0, take).join(" ");
        const found = indexWithin(folded, lead, cursor, limit);
        if (found >= 0) {
          at = found;
          end = found + lead.length;
          break;
        }
      }
    }
    if (at < 0) continue;
    const offset = map[at];
    if (offset == null) continue;
    starts[i] = offset;
    cursor = end;
  }
  return starts;
}

/** `indexOf`, but a hit past `limit` is not a hit. */
function indexWithin(
  haystack: string,
  needle: string,
  from: number,
  limit: number
): number {
  if (!needle) return -1;
  const at = haystack.indexOf(needle, from);
  if (at < 0 || at > limit) return -1;
  return at;
}

/**
 * Narrate a block list and record where each block landed.
 *
 * The text is the shared whole-document pass, so `content.txt` for a given
 * source does not change when this path is used.
 */
export function speakableFromBlocks(blocks: BookBlock[]): SpeakableProjection {
  const text = toSpeakableText(blocksToSourceText(blocks), { normalizeTitles: false });
  return { text, blockStart: locateBlockStarts(text, blocks) };
}

/** Test hook: the folded form of a block's text. */
export function foldAll(text: string): string {
  return foldWithMap(text).folded;
}
