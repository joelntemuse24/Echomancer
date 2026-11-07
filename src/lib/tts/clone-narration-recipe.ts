/**
 * The identity of the *narration recipe* a clone take was rendered with.
 *
 * ## Why this exists
 *
 * The section cache is content-addressed on (text, voice, model, latency, speed,
 * chunk length, variant). Everything that changes the audio has to be inside
 * that key, or a book can be assembled from takes recorded under a completely
 * different recipe. `job 75944dc9` (2026-11-06) is what that looks like from the
 * outside: after #246 shipped 560-character units, five of its eleven sections
 * were **byte-identical** to files from builds `1e9a10bbf103` and
 * `f55abd34001a` — S2C8 and S2C7, i.e. 400- and 300-character units. Not one
 * second of that book came from the new runtime, so the new narration never
 * played, and the shortfall looked like a speed change instead.
 *
 * The variant was `s2-pro-modal-v1`: it named the *engine* and a hand-bumped
 * version, not the thing that makes the audio different. Bumping it by hand
 * after every tuning change is exactly the step that gets forgotten (it was
 * forgotten twice: #244 and #245 both changed unit width and left it alone, and
 * #246 inherited the same value).
 *
 * ## What is in it
 *
 * Only inputs the **container** actually reads, which is the set that can change
 * a take's audio:
 *
 *   - the unit ceiling (`UNIT_MAX_CHARS`) — the width of one generation;
 *   - the paragraph-merge width (`MERGE_PARA_MAX_CHARS`);
 *   - the inter-unit pause ladder, because inserted silence is spliced into the
 *     file;
 *   - the history anchor mode, because which take conditions the next unit
 *     changes the voice;
 *   - the engine, because S2-Pro and direct Fish are different models.
 *
 * Deliberately **not** in it: a deploy id, a git SHA, or `S2C_BUILD`. Those
 * change on every release, including releases that cannot alter a single sample
 * (a log line, a test, a docs edit). Including one would throw away a cache of
 * genuinely identical audio on every deploy — thousands of sections of paid GPU
 * time — to protect against a case the recipe fields already cover exactly.
 *
 * The numbers here are a mirror of `modal/s2_contract.py`. They are not typed by
 * hand in two places and trusted: `clone-narration-recipe.test.ts` parses the
 * Python module and fails if the mirror and the container disagree, so a recipe
 * change cannot ship without moving the cache identity with it.
 */

/** Unit ceiling and merge width, mirrored from `modal/s2_contract.py`. */
export const CLONE_UNIT_MAX_CHARS = 560;
export const CLONE_MERGE_PARA_MAX_CHARS = 260;

/** Inter-unit pauses in seconds, mirrored from `modal/s2_contract.py`. */
export const CLONE_CLAUSE_PAUSE_S = 0.22;
export const CLONE_SENTENCE_PAUSE_S = 0.4;
export const CLONE_PARAGRAPH_PAUSE_S = 0.96;

/**
 * `first` = every unit is conditioned on the row's first take (#244's drift
 * fix); `last` = the upstream previous-turn chain, which drifted.
 */
export type CloneHistoryAnchor = "first" | "last";
export const CLONE_HISTORY_ANCHOR: CloneHistoryAnchor = "first";

/**
 * A short, stable, human-readable recipe id.
 *
 * Readable on purpose: a key like `u560-p022-040-096-a1` says why a cache miss
 * happened, where a hash would leave an operator guessing. It is also small
 * enough to keep inside a cache key without a second hash.
 */
export function cloneNarrationRecipeId(opts?: {
  unitMaxChars?: number;
  mergeParaMaxChars?: number;
  clausePauseS?: number;
  sentencePauseS?: number;
  paragraphPauseS?: number;
  history?: CloneHistoryAnchor;
}): string {
  const unitMax = opts?.unitMaxChars ?? CLONE_UNIT_MAX_CHARS;
  const merge = opts?.mergeParaMaxChars ?? CLONE_MERGE_PARA_MAX_CHARS;
  const pause = (value: number): string =>
    String(Math.round((Number.isFinite(value) ? value : 0) * 1000)).padStart(3, "0");
  return [
    `u${unitMax}`,
    `m${merge}`,
    `p${pause(opts?.clausePauseS ?? CLONE_CLAUSE_PAUSE_S)}-` +
      `${pause(opts?.sentencePauseS ?? CLONE_SENTENCE_PAUSE_S)}-` +
      `${pause(opts?.paragraphPauseS ?? CLONE_PARAGRAPH_PAUSE_S)}`,
    `a${(opts?.history ?? CLONE_HISTORY_ANCHOR) === "first" ? 1 : 0}`,
  ].join("-");
}
