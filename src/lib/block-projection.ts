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
/** Shortest folded lead accepted for a block the narrator rewrote. */
const MIN_LEAD_WORDS = 3;
/** Longest folded lead tried before giving up on a rewritten block. */
const MAX_LEAD_WORDS = 12;

export function locateBlockStarts(text: string, blocks: BookBlock[]): number[] {
  const { folded, map } = foldWithMap(text);
  const starts = new Array<number>(blocks.length).fill(-1);
  let cursor = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const needle = foldWithMap(block.text).folded;
    if (!needle) continue;
    let at = folded.indexOf(needle, cursor);
    let end = at >= 0 ? at + needle.length : -1;
    if (at < 0) {
      // A block the narrator rewrote is still worth finding: its first few
      // words usually survive, and a chapter start is only needed once.
      const words = needle.split(" ");
      for (let take = Math.min(words.length - 1, MAX_LEAD_WORDS); take >= MIN_LEAD_WORDS; take -= 1) {
        const lead = words.slice(0, take).join(" ");
        const found = folded.indexOf(lead, cursor);
        if (found >= 0) {
          at = found;
          // Advance by what matched, not by the whole block, or the cursor
          // runs past the blocks that follow it.
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
