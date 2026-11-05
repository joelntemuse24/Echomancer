/**
 * Four-lane dispatch for the self-hosted S2-Pro clone path.
 *
 * One lane is one HTTP batch call, and Modal starts one container per
 * concurrent call, so the lane count *is* the number of GPUs this book uses.
 * That is deliberate: GPU memory snapshots are documented as generally
 * incompatible with multi-GPU programs, so replicas are the scaling unit.
 *
 * The plan is pure so it can be tested without a GPU or a Modal token.
 */

export interface LaneLimits {
  /** Concurrent batch calls (containers) this book may fill. */
  lanes: number;
  /** Rows per call; the container clamps this to its decode batch. */
  batch: number;
  /** Characters one lane may carry, so a long section cannot hog a GPU. */
  maxLaneChars: number;
}

export interface LanePlanInput {
  /** Claimable section indexes, ascending. */
  pending: number[];
  /** Section text by index. */
  textAt: (index: number) => string;
  limits: LaneLimits;
}

export interface LanePlan {
  /** Index lists, one per call actually worth making. */
  lanes: number[][];
  /** Indexes left for a later tick because every lane filled. */
  deferred: number[];
}

/** A lane carrying less than this is not worth a container. */
export const MODAL_LANE_MIN_CHARS = 400;

export function planModalCloneLanes(input: LanePlanInput): LanePlan {
  if (input.limits.lanes < 1) {
    throw new Error("lanes must be at least 1");
  }
  if (input.limits.batch < 1) {
    throw new Error("batch must be at least 1");
  }
  const lanes = Math.floor(input.limits.lanes);
  const batch = Math.floor(input.limits.batch);
  const maxChars = Math.max(
    MODAL_LANE_MIN_CHARS,
    Math.floor(input.limits.maxLaneChars)
  );

  const groups: number[][] = Array.from({ length: lanes }, () => []);
  const chars = new Array<number>(lanes).fill(0);
  const deferred: number[] = [];

  for (const index of input.pending) {
    const text = input.textAt(index);
    const size = text.length;
    let placed = false;
    // Fill the emptiest lane that can hold this section, so one very long
    // section does not sit behind every other section on the same lane.
    const order = [...groups.keys()].sort((a, b) => chars[a]! - chars[b]!);
    for (const lane of order) {
      if (groups[lane]!.length >= batch) continue;
      if (chars[lane]! > 0 && chars[lane]! + size > maxChars) continue;
      groups[lane]!.push(index);
      chars[lane]! += size;
      placed = true;
      break;
    }
    if (!placed) deferred.push(index);
  }

  const used = groups.filter((group) => group.length > 0);
  // Each lane keeps ascending index order: the worker stages results by index,
  // and a section's row order inside the call must not imply playback order.
  for (const group of used) group.sort((a, b) => a - b);
  return { lanes: used, deferred };
}

/**
 * Splits one lane's indexes into pages the server will accept. A lane normally
 * fits in one call; this only guards a misconfigured batch size.
 */
export function pageLane(indexes: number[], batch: number): number[][] {
  const size = Math.max(1, Math.floor(batch));
  const pages: number[][] = [];
  for (let i = 0; i < indexes.length; i += size) {
    pages.push(indexes.slice(i, i + size));
  }
  return pages;
}

/**
 * Retry epoch for a section. Every retry moves the epoch, which moves the
 * render seed, so a retry produces a *different* take instead of billing a
 * second one identical to the first.
 */
export function sectionSeedEpoch(priorAttempts: number): number {
  return Math.max(0, Math.floor(priorAttempts));
}
