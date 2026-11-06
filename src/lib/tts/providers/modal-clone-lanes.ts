/**
 * Lane dispatch for the self-hosted S2-Pro clone path.
 *
 * One lane is one HTTP batch call, and Modal starts one container per
 * concurrent call, so the lane count *is* the number of GPUs this book uses.
 * That is deliberate: GPU memory snapshots are documented as generally
 * incompatible with multi-GPU programs, so replicas are the scaling unit.
 *
 * ## Why rows per call matter more than lanes
 *
 * The container decodes every row of a call in one batch, so GPU cost is
 * nearly flat in rows: measured **2.9x realtime for a one-row call and 35–65x
 * for a full one** (`modal-clone.ts`). A call carrying one section therefore
 * wastes almost the whole GPU, and two calls carrying one row each are ~10x
 * worse in aggregate than one call carrying both — even though they look like
 * "more parallelism".
 *
 * That is what the 2026-11-06 Alice smoke (`job db10a6d6`) measured. Five
 * sections were planned across four lanes as `[[0],[1],[2],[3]]` with `[4]`
 * deferred, so every call carried a single row, and all four calls landed on
 * the one container that had restored (`36459a5cb16f`, reported by every lane).
 * One GPU thread served them in sequence at the one-row rate: 246s of audio in
 * 84s of GPU wall, **2.93x realtime**. Section 0 — the only section the player
 * can start with — was last of the four, at +141s.
 *
 * So the plan fills each call toward `batch` before opening the next, and the
 * batch size is the real concurrency knob. `lanes` stays the cap on how many
 * calls a book may have in flight.
 *
 * The plan is pure so it can be tested without a GPU or a Modal token.
 */

export interface LaneLimits {
  /** Concurrent batch calls (containers) this book may fill. */
  lanes: number;
  /**
   * Rows per call. This is the throughput knob, not the lane count: the
   * container decodes all of them in one batch.
   */
  batch: number;
  /**
   * Optional ceiling on the characters one call may carry, so a call made of
   * very long sections still fits the steady-state HTTP timeout. Unset means
   * `batch` rows is the only limit.
   */
  maxLaneChars?: number;
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
  const maxChars =
    typeof input.limits.maxLaneChars === "number" &&
    Number.isFinite(input.limits.maxLaneChars)
      ? Math.max(MODAL_LANE_MIN_CHARS, Math.floor(input.limits.maxLaneChars))
      : Number.POSITIVE_INFINITY;

  const groups: number[][] = Array.from({ length: lanes }, () => []);
  const chars = new Array<number>(lanes).fill(0);
  const deferred: number[] = [];

  for (const index of input.pending) {
    const size = input.textAt(index).length;
    let placed = false;
    // Fill the first lane that can still take this section, in lane order.
    // Filling one call toward `batch` is what keeps the GPU efficient; a
    // round-robin split into thin lanes is what made every call a one-row call.
    // A lane that is already full by characters is skipped, so a long section
    // cannot push a call past the timeout.
    for (let lane = 0; lane < lanes; lane += 1) {
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
 * Characters one call may carry, from the steady-state timeout and the
 * container's measured throughput.
 *
 * A call is only worth its GPU when it is full, but a full call of very long
 * sections must not outrun `MODAL_S2_TIMEOUT_MS`. At the documented one-row
 * rate of 2.9x realtime, one second of wall covers ~2,900 characters of
 * narration; half of that leaves room for a container slower than the
 * measurement. `MODAL_S2_LANE_MAX_CHARS` overrides it for an unusual voice.
 */
export const MODAL_LANE_CHARS_PER_SECOND = 2_900;

export function modalLaneCharCap(
  callTimeoutMs: number,
  env: NodeJS.ProcessEnv = process.env
): number {
  const override = Number(env.MODAL_S2_LANE_MAX_CHARS);
  if (Number.isFinite(override) && override > 0) return Math.floor(override);
  const seconds = Math.max(1, callTimeoutMs / 1000);
  return Math.floor(seconds * MODAL_LANE_CHARS_PER_SECOND * 0.5);
}

/**
 * Retry epoch for a section. Every retry moves the epoch, which moves the
 * render seed, so a retry produces a *different* take instead of billing a
 * second one identical to the first.
 */
export function sectionSeedEpoch(priorAttempts: number): number {
  return Math.max(0, Math.floor(priorAttempts));
}
