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
 * for a full one** (`modal-clone.ts`). Note what those units are: **audio
 * seconds per wall second**, not characters per second. At 900 characters per
 * audio minute that is ~43 chars/s for one row and ~525–975 chars/s when a
 * batch of ~24 is full. A call carrying one section therefore wastes almost
 * the whole GPU, and two calls carrying one row each are far worse in aggregate
 * than one call carrying both even though they look like "more parallelism".
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
 * ## …but a call must also finish
 *
 * Filling toward `batch` alone is not safe, and `job 7e4a8b48` (2026-11-06) is
 * what happens when it is not: four ~7.7k-character sections became one call
 * that ran 4m03s and never finished, because the character cap it was packed
 * against came from a throughput figure that was off by ~67x. A lane is
 * therefore also bounded by {@link modalLaneCharLimit} — the narration one call
 * can actually finish inside the wait it is granted.
 *
 * The plan is pure so it can be tested without a GPU or a Modal token.
 */

import {
  MODAL_CLONE_CALL_PREP_MS,
  MODAL_CLONE_COLD_WAIT_MAX_MS,
  modalCloneColdWaitMs,
} from "@/lib/tts/providers/modal-clone-guard";

export interface LaneLimits {
  /** Concurrent batch calls (containers) this book may fill. */
  lanes: number;
  /**
   * Rows per call. This is the throughput knob, not the lane count: the
   * container decodes all of them in one batch.
   */
  batch: number;
  /**
   * Ceiling on the characters one call may carry, so a call made of very long
   * sections still finishes inside the wait it is granted. Unset means `batch`
   * rows is the only limit — production always passes
   * {@link modalLaneCharLimit}.
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
    // A lane that is already full **by characters** is skipped, so no call is
    // ever planned past the narration it can finish in its own wait.
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
 * Conservative **aggregate** narration throughput of one clone call, in
 * characters per wall second.
 *
 * This used to be `2_900`, and that single constant is what broke production on
 * `job 7e4a8b48` (2026-11-06). It came from the *2.9x realtime* one-row
 * measurement, but realtime is **audio seconds per wall second**, not
 * characters. At 900 characters per audio minute a 2.9x call produces about
 * **43 chars/s**, so 2,900 overstated throughput by ~67x. An 87,000-character
 * cap therefore looked safe, and one call swallowed 31k characters that needed
 * more than four minutes.
 *
 * Two measurements from that book set the real numbers:
 *
 *   - **one row**: 797 chars / 2 paragraph units in **15.9s** of generation →
 *     **50 chars/s**, about 8s per 400-char unit. A row's units are generated
 *     in sequence (each carries the previous unit as history), so one row gets
 *     no faster with more text.
 *   - **four rows, ~31k chars, not finished after 243s** → **≥127 chars/s**
 *     aggregate. Rows run in parallel, which is where batching earns its keep.
 *
 * 100 is the conservative end of that aggregate band, matching the operator's
 * working `MODAL_S2_LANE_MAX_CHARS=8000` stopgap: at the default 80s generation
 * budget it yields exactly 8,000 characters per call.
 */
export const MODAL_LANE_CHARS_PER_SECOND = 100;

/**
 * Conservative throughput of **one row**, which is the shape a single-section
 * call takes. Slower than the aggregate because there is nothing to overlap.
 * Used to size the wait for a call rather than the call itself.
 */
export const MODAL_LANE_ROW_CHARS_PER_SECOND = 50;

/**
 * What a cold call spends before it generates anything.
 *
 * Measured: ~57s for a snapshot restore, then ~12s of reference encode and
 * prompt preparation on `job 7e4a8b48` (28.3s of execution, 15.9s of it
 * generation). A restore wait that has already spent this much has only the
 * remainder left for narration, so packing must not plan into it.
 */
export const MODAL_LANE_RESTORE_MARGIN_MS = 70_000;

/**
 * Generation milliseconds one lane call can rely on.
 *
 * The pool's state is not knowable when the plan is made — production runs with
 * `MODAL_S2_READY=0`, so every call is treated as a possible restore — so a
 * planned lane has to fit the **cold** budget minus its restore margin.
 */
export function modalCloneLaneGenerateBudgetMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  return Math.max(1_000, modalCloneColdWaitMs(env) - MODAL_LANE_RESTORE_MARGIN_MS);
}

/**
 * The most characters one call may ever be planned to carry.
 *
 * The invariant this file exists for: **never schedule a call that cannot
 * finish inside the wait it can be granted.** The widest wait any lane may get
 * is the hard ceiling (`MODAL_CLONE_COLD_WAIT_MAX_MS`, below a compile by
 * design), so this is the generation budget at the conservative aggregate rate.
 * `MODAL_S2_LANE_MAX_CHARS` can only lower it: a stopgap override must not be
 * able to recreate `job 7e4a8b48`.
 */
export function modalLaneCharCeiling(env: NodeJS.ProcessEnv = process.env): number {
  const generateMs = Math.max(
    1_000,
    Math.min(modalCloneColdWaitMs(env), MODAL_CLONE_COLD_WAIT_MAX_MS) -
      MODAL_CLONE_CALL_PREP_MS
  );
  return Math.max(
    MODAL_LANE_MIN_CHARS,
    Math.floor((generateMs / 1000) * MODAL_LANE_CHARS_PER_SECOND)
  );
}

export function modalLaneCharCap(env: NodeJS.ProcessEnv = process.env): number {
  const seconds = modalCloneLaneGenerateBudgetMs(env) / 1000;
  const derived = Math.max(
    MODAL_LANE_MIN_CHARS,
    Math.floor(seconds * MODAL_LANE_CHARS_PER_SECOND)
  );
  const ceiling = Math.max(derived, modalLaneCharCeiling(env));
  const override = Number(env.MODAL_S2_LANE_MAX_CHARS);
  if (Number.isFinite(override) && override > 0) {
    return Math.min(ceiling, Math.floor(override));
  }
  return Math.min(ceiling, derived);
}

/**
 * Narration milliseconds a planned page is expected to need.
 *
 * A call's wall time is set by its **longest row**, not by its total: rows run
 * in parallel. So the estimate is the worse of the two rates — the aggregate
 * for the whole page, and the single-row rate for its biggest section. Feeding
 * this into the call's own wait is what stops a lane the packer believes fits
 * from being cut off by a shorter timeout.
 */
export function modalLaneWorkMs(
  pageChars: number,
  largestRowChars: number
): number {
  const aggregate = (pageChars / MODAL_LANE_CHARS_PER_SECOND) * 1000;
  const slowestRow = (largestRowChars / MODAL_LANE_ROW_CHARS_PER_SECOND) * 1000;
  return Math.max(0, Math.round(Math.max(aggregate, slowestRow)));
}

/**
 * Per-section character target for the Modal clone path.
 *
 * Section sizes were the other half of `job 7e4a8b48`. That book packed at
 * `evenFanout=4` over ~31k characters, which produced four ~7.7k sections. A
 * row generates its paragraph units **in sequence** at the measured ~50 chars/s,
 * so a 7.7k row needs ~154s of generation before any restore is counted — more
 * than the whole 150s placement budget. No packer, retry shape, or lane count
 * can rescue a row that is larger than a call.
 *
 * ~2,000 characters is ~40s per row, and four such rows in one call is ~80s of
 * aggregate work: comfortably inside the budget, and full enough that batching
 * still pays. It is also the size the successful Alice smokes packed to
 * (1,609–2,130), so it is a measured shape rather than a guess.
 */
export const MODAL_CLONE_SECTION_CHARS_DEFAULT = 2_000;

export function modalCloneSectionChars(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.MODAL_S2_SECTION_CHARS);
  const chosen = Number.isFinite(raw) && raw >= MODAL_LANE_MIN_CHARS ? Math.floor(raw) : 0;
  const target = chosen > 0 ? chosen : MODAL_CLONE_SECTION_CHARS_DEFAULT;
  // A section may never be planned larger than one call can render: the caller
  // packs at this width, so this is the one place that bounds a row.
  return Math.max(MODAL_LANE_MIN_CHARS, Math.min(target, modalLaneCharCap(env)));
}

/**
 * The character limit one tick passes to the planner.
 *
 * This is {@link modalLaneCharCap}. An individual section larger than the cap
 * is still schedulable, alone, because this layer cannot split one section
 * across lanes — see {@link planModalCloneLanes}. It is never allowed to share
 * a call, so a long section cannot drag a neighbour past the budget with it.
 */
export function modalLaneCharLimit(
  env: NodeJS.ProcessEnv = process.env
): number {
  return modalLaneCharCap(env);
}

/**
 * Retry epoch for a section. Every retry moves the epoch, which moves the
 * render seed, so a retry produces a *different* take instead of billing a
 * second one identical to the first.
 */
export function sectionSeedEpoch(priorAttempts: number): number {
  return Math.max(0, Math.floor(priorAttempts));
}
