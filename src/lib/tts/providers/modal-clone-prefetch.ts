/**
 * What a clone tick should render, and what it should publish from cache.
 *
 * The GPU batch is larger than the publish window (`MODAL_S2_BATCH_SIZE` 24,
 * `SECTION_FANOUT_HARD_MAX` 8). A tick that renders every claimable index and
 * then publishes only 8 leaves the rest in the section cache. The next tick
 * used to send those same indexes to the GPU again. `S2 lane staged` is
 * written only after a row comes back, so a repeated line is another
 * synthesis, not a cache read.
 *
 * Rendering skips indexes that already have a take. Publishing walks the
 * claimable list in order and stops at the first index that is not cached
 * yet, so a later section is never published ahead of a hole.
 */

/** Indexes to render this tick, and how many cached indexes were stepped over. */
export function selectCloneRenderIndexes(
  indexes: readonly number[],
  isCached: (index: number) => boolean,
  budget: number
): { render: number[]; skippedCached: number } {
  const render: number[] = [];
  let skippedCached = 0;
  const cap = Math.max(0, Math.floor(budget));
  for (const index of indexes) {
    if (render.length >= cap) break;
    if (isCached(index)) {
      skippedCached += 1;
      continue;
    }
    render.push(index);
  }
  return { render, skippedCached };
}

/**
 * The next publish window.
 *
 * Stops at `limit`, at an index in `blocked` (still on the GPU), and at the
 * first index that is not cached. Later cached indexes stay put until the
 * hole in front of them is filled, which keeps playback order.
 */
export function selectClonePublishBatch(
  indexes: readonly number[],
  isCached: (index: number) => boolean,
  blocked: ReadonlySet<number>,
  limit: number
): number[] {
  const out: number[] = [];
  const cap = Math.max(0, Math.floor(limit));
  for (const index of indexes) {
    if (out.length >= cap) break;
    if (blocked.has(index)) break;
    if (!isCached(index)) break;
    out.push(index);
  }
  return out;
}
