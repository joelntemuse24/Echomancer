/**
 * Lane dispatch for the self-hosted S2-Pro clone path.
 *
 * One lane is one HTTP batch call, and Modal starts one container per
 * concurrent call. The book schedule (`planModalCloneBookWave`) uses one
 * lane: the GPU this book already restored. Opening a second call opens a
 * second GPU when the autoscaler cap is above 1, which this path does not do.
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
  CLONE_CHARS_PER_AUDIO_MINUTE,
  MODAL_CLONE_CALL_PREP_MS,
  MODAL_CLONE_COLD_WAIT_MAX_MS,
  modalCloneColdWaitMs,
  modalCloneFirstLightWaitMs,
  modalCloneWarmHoldMs,
  modalCloneWarmWaitMs,
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
 * Expected aggregate rate of a full S2-Pro batch: the low end of the
 * documented 35–65× realtime band, times 15 characters per audio second.
 * Not a 24-row measurement. Packing does not use this number.
 */
export const MODAL_LANE_WARM_CHARS_PER_SECOND = 525;

/**
 * Rate a warm call is packed against.
 *
 * A one-row H100 call is ~50 chars/s. The unfinished four-row call on
 * `job 7e4a8b48` was already at least 127 chars/s when it was aborted, and
 * a full 24-row batch should be faster because the model rereads its weights
 * per frame. 150 sits just above that floor and well under the 525 chars/s
 * the 35× band implies, so a batch that only partly fills the GPU still
 * finishes inside its wait. The old 2,900 constant was a unit error
 * (realtime treated as chars/s) and is what let one call swallow 31k chars.
 */
export const MODAL_LANE_WARM_PACK_CHARS_PER_SECOND = 150;

/**
 * Largest base64 JSON body a warm call is allowed to plan.
 *
 * Production returns `audio_b64` over HTTP. A box-side `.remote()` download
 * of a multi-megabyte body was truncated (`ContentLengthError`) on
 * 2026-11-10; HTTP is a different path, and this change does not alter the
 * deployed container's contract. The bound keeps one response near 80 MiB
 * of base64 (about 60 MiB of 128 kbps MP3). A paid smoke has to confirm the
 * body arrives whole.
 */
export const MODAL_CLONE_RESPONSE_BODY_MAX_BYTES = 80 * 1024 * 1024;

/** 128 kbps mono MP3, then base64 (4/3), at the narration rate. */
export function estimateCloneBatchJsonBytes(chars: number): number {
  const audioSeconds = (Math.max(0, chars) / CLONE_CHARS_PER_AUDIO_MINUTE) * 60;
  const mp3Bytes = audioSeconds * (128_000 / 8);
  return Math.ceil((mp3Bytes * 4) / 3);
}

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
  largestRowChars: number,
  charsPerSecond: number = MODAL_LANE_CHARS_PER_SECOND
): number {
  const rate = charsPerSecond > 0 ? charsPerSecond : MODAL_LANE_CHARS_PER_SECOND;
  const aggregate = (pageChars / rate) * 1000;
  const slowestRow = (largestRowChars / MODAL_LANE_ROW_CHARS_PER_SECOND) * 1000;
  return Math.max(0, Math.round(Math.max(aggregate, slowestRow)));
}

/**
 * Characters one warm call may carry.
 *
 * Time is the warm wait minus prep, at the packing rate. Bytes are the
 * base64 ceiling. `MODAL_S2_WARM_LANE_MAX_CHARS` can only lower the result,
 * the same way `MODAL_S2_LANE_MAX_CHARS` can only lower a cold call.
 */
export function modalWarmLaneCharLimit(env: NodeJS.ProcessEnv = process.env): number {
  const generateMs = Math.max(1_000, modalCloneWarmWaitMs(env) - MODAL_CLONE_CALL_PREP_MS);
  const byTime = Math.floor((generateMs / 1000) * MODAL_LANE_WARM_PACK_CHARS_PER_SECOND);
  const perChar = estimateCloneBatchJsonBytes(10_000) / 10_000;
  const byResponse = Math.floor(MODAL_CLONE_RESPONSE_BODY_MAX_BYTES / perChar);
  const cap = Math.max(MODAL_LANE_MIN_CHARS, Math.min(byTime, byResponse));
  const override = Number(env.MODAL_S2_WARM_LANE_MAX_CHARS);
  if (!Number.isFinite(override) || override <= 0) return cap;
  return Math.min(cap, Math.floor(override));
}

/**
 * True while a successful answer is still inside the scaledown hold.
 * `answeredAt` is null until this process has heard the container.
 */
export function clonePoolStillWarm(
  now: number,
  answeredAt: number | null,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (answeredAt == null || !Number.isFinite(answeredAt) || !Number.isFinite(now)) return false;
  if (now < answeredAt) return false;
  return now - answeredAt <= modalCloneWarmHoldMs(env);
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

export type CloneWaveShape = "cold" | "warm";

export type CloneWaveCall = {
  indexes: number[];
  shape: CloneWaveShape;
  chars: number;
  /** Generation time the packing rate assigns this call. */
  workMs: number;
  /** HTTP wait this call is allowed. A warm wait is the full warm budget. */
  waitMs: number;
};

export type CloneBookWavePlan = {
  calls: CloneWaveCall[];
  deferred: number[];
  /** One restored GPU. Calls in `calls` run in order, never together. */
  parallelLanes: 1;
};

/**
 * One book's next GPU calls.
 *
 * The first section of a book is its own cold-sized call, so a restore can
 * finish and the listener hears audio before a full batch is in flight.
 * The call after that — in this same plan, and only sent once the first one
 * has returned — fills one batch. A later tick does the same while
 * `poolWarm` is set. When the container has been idle longer than
 * scaledown, the tick is one cold-sized call again and the rest waits.
 *
 * `gpuBusy` means another book already has this GPU. Nothing is sent.
 */
export function planModalCloneBookWave(input: {
  pending: number[];
  textAt: (index: number) => string;
  firstLight: boolean;
  poolWarm: boolean;
  batch: number;
  gpuBusy?: boolean;
  env?: NodeJS.ProcessEnv;
}): CloneBookWavePlan {
  const env = input.env ?? process.env;
  const pending = [...input.pending].sort((a, b) => a - b);
  if (input.gpuBusy || pending.length === 0) {
    return { calls: [], deferred: pending, parallelLanes: 1 };
  }
  const calls: CloneWaveCall[] = [];
  let rest = pending;
  if (input.firstLight) {
    const head = rest[0]!;
    rest = rest.slice(1);
    calls.push(describeCloneWaveCall([head], "cold", true, input.textAt, env));
  }
  let deferred: number[] = [];
  if (rest.length > 0) {
    // The first-light call is what restores the container. The call planned
    // after it is the fat batch, and it is only sent once that call returns.
    const warm = input.firstLight || input.poolWarm;
    const packed = planModalCloneLanes({
      pending: rest,
      textAt: input.textAt,
      limits: {
        lanes: 1,
        batch: input.batch,
        maxLaneChars: warm ? modalWarmLaneCharLimit(env) : modalLaneCharLimit(env),
      },
    });
    const lane = packed.lanes[0];
    if (lane && lane.length > 0) {
      calls.push(describeCloneWaveCall(lane, warm ? "warm" : "cold", false, input.textAt, env));
    }
    deferred = packed.deferred;
  }
  return { calls, deferred, parallelLanes: 1 };
}

function describeCloneWaveCall(
  indexes: number[],
  shape: CloneWaveShape,
  firstLight: boolean,
  textAt: (index: number) => string,
  env: NodeJS.ProcessEnv
): CloneWaveCall {
  let chars = 0;
  let largest = 0;
  for (const index of indexes) {
    const size = textAt(index).length;
    chars += size;
    if (size > largest) largest = size;
  }
  const workMs = modalLaneWorkMs(
    chars,
    largest,
    shape === "warm" ? MODAL_LANE_WARM_PACK_CHARS_PER_SECOND : MODAL_LANE_CHARS_PER_SECOND
  );
  const need = workMs + MODAL_CLONE_CALL_PREP_MS;
  const waitMs =
    shape === "warm"
      ? modalCloneWarmWaitMs(env)
      : Math.min(
          MODAL_CLONE_COLD_WAIT_MAX_MS,
          Math.max(firstLight ? modalCloneFirstLightWaitMs(env) : modalCloneColdWaitMs(env), need)
        );
  return { indexes: [...indexes], shape, chars, workMs, waitMs };
}

/**
 * Two books, one GPU. The active book gets the schedule above. The other
 * book sends nothing this wave; its own first call is still one section
 * when it becomes active, even if the pool is already warm.
 */
export function planTwoBooksOnOneGpu(input: {
  active: {
    pending: number[];
    textAt: (index: number) => string;
    firstLight: boolean;
    poolWarm: boolean;
  };
  waiting: {
    pending: number[];
    textAt: (index: number) => string;
    firstLight: boolean;
    poolWarm: boolean;
  };
  batch: number;
  env?: NodeJS.ProcessEnv;
}): { active: CloneBookWavePlan; waiting: CloneBookWavePlan } {
  const shared = { batch: input.batch, env: input.env };
  return {
    active: planModalCloneBookWave({ ...input.active, ...shared, gpuBusy: false }),
    waiting: planModalCloneBookWave({ ...input.waiting, ...shared, gpuBusy: true }),
  };
}
