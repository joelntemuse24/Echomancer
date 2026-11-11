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
 * So the cold packer fills each call toward `batch` before opening the next,
 * and the batch size is the real concurrency knob. `lanes` stays the cap on
 * how many calls a book may have in flight. Once the container has answered,
 * `planModalCloneBookWave` does not jump to that full batch: each next call
 * is only as large as the audio already buffered ahead of the listener can
 * cover, and the calls run back to back on the one GPU.
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
  MODAL_CLONE_PROXY_KILL_MS,
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
 * Listener-facing rates from the 2026-11-11 paid smoke (one H100, HTTPS
 * `/synthesize_batch`, sequential ramp). The cold character cap above stays
 * at 100 chars/s. These numbers are only how long the listener waits.
 *
 * Single row, end to end: 1,300 characters in 39.85s → ~33 chars/s.
 * The older 50 chars/s figure was generation on one short row, and it let
 * a 2,000-character second call be planned into ~53s of section-0 audio.
 * Server aggregate for wider calls, before transfer: 266 chars/s at 8 rows,
 * 371 at 14, 617 at 24. The per-row planning rate is 15% under those, so a
 * wide call is not packed at the flat 150 chars/s cap rate.
 */
export const MODAL_CLONE_ROW_CHARS_PER_SECOND = 33;

/** 15% under the measured server per-row rate. The 1-row point is 33, not 33×0.85. */
export const MODAL_CLONE_WIDE_RATE_MARGIN = 0.85;

const CLONE_RATE_ANCHORS: ReadonlyArray<{ rows: number; perRow: number }> = [
  { rows: 1, perRow: MODAL_CLONE_ROW_CHARS_PER_SECOND },
  { rows: 8, perRow: (266 / 8) * MODAL_CLONE_WIDE_RATE_MARGIN },
  { rows: 14, perRow: (371 / 14) * MODAL_CLONE_WIDE_RATE_MARGIN },
  { rows: 24, perRow: (617 / 24) * MODAL_CLONE_WIDE_RATE_MARGIN },
];

/** Chars/s of one row at this call width. Wider calls are slower per row. */
export function cloneRowCharsPerSecond(rows: number): number {
  const n = Math.max(1, rows);
  const first = CLONE_RATE_ANCHORS[0]!;
  if (n <= first.rows) return first.perRow;
  const last = CLONE_RATE_ANCHORS[CLONE_RATE_ANCHORS.length - 1]!;
  if (n >= last.rows) return last.perRow;
  let hi = 1;
  while (CLONE_RATE_ANCHORS[hi]!.rows < n) hi += 1;
  const left = CLONE_RATE_ANCHORS[hi - 1]!;
  const right = CLONE_RATE_ANCHORS[hi]!;
  const t = (n - left.rows) / (right.rows - left.rows);
  return left.perRow + (right.perRow - left.perRow) * t;
}

/** Generation time for the whole call. Rows share the batch; the rate already says so. */
export function cloneGenerationMs(chars: number, rows: number): number {
  const n = Math.max(1, Math.floor(rows) || 1);
  const aggregate = cloneRowCharsPerSecond(n) * n;
  if (!(aggregate > 0)) return 0;
  return Math.round((Math.max(0, chars) / aggregate) * 1000);
}

/**
 * Cold-call overhead that is not generation.
 *
 * The same smoke: 673 characters, 57.05s wall, 18.8s on the server, ~0.2s
 * to move the 0.94MB body. 57.05 − 18.8 − 0.2 ≈ 38s of restore and proxy,
 * not a 57s restore stacked on top of generation. The old 57s constant made
 * an 800-character opening look like 88s.
 */
export const MODAL_CLONE_RESTORE_EXPECTED_MS = 38_000;

/**
 * Transfer, from the 24-row body: 58.7MB took ~12s. That is 12s for the
 * 43,907 characters in that call, linear in characters. The 80 MiB planner
 * cap still uses {@link estimateCloneBatchJsonBytes}, which is a little
 * larger than this smoke's bodies.
 */
export const MODAL_CLONE_TRANSFER_REFERENCE_CHARS = 43_907;
export const MODAL_CLONE_TRANSFER_REFERENCE_MS = 12_000;

/**
 * Spare audio every call must leave, including a one-row call.
 *
 * The smoke's second call returned with 4.3s left. That is not a margin.
 * 15s is the floor; a deep buffer also keeps 10% of itself.
 */
export const MODAL_CLONE_RAMP_SLACK_MIN_MS = 15_000;
export const MODAL_CLONE_RAMP_SLACK_RATIO = 0.1;

/**
 * Clone section 0. Larger than the 800-character opening every other
 * provider uses, and still one cold row under the 75s first-light wait.
 * 1,000 characters is ~63s of audio at the smoke's narration rate, and the
 * planned cold wall is ~69s.
 */
export const MODAL_CLONE_OPENING_SECTION_CHARS = 1_000;

/**
 * The call after section 0. The smoke's 1,300-character row took 39.85s.
 * Against ~63s of opening audio that leaves ~23s, which clears the 15s
 * floor. 1,600 against this opening leaves ~14s, so the cap stays 1,300
 * rather than the top of that range. Later sections stay at 2,000.
 */
export const MODAL_CLONE_SECOND_CALL_CHARS = 1_300;

/** Narration rate measured on the smoke, not the 900-character product minute. */
export const MODAL_CLONE_CHARS_PER_AUDIO_SECOND = 15.85;

/** Narration milliseconds of `chars` at the smoke's 15.85 characters per audio second. */
export function cloneAudioMs(chars: number): number {
  return Math.round((Math.max(0, chars) / MODAL_CLONE_CHARS_PER_AUDIO_SECOND) * 1000);
}

export function cloneTransferMs(chars: number): number {
  if (!(chars > 0)) return 0;
  return Math.round(
    (chars / MODAL_CLONE_TRANSFER_REFERENCE_CHARS) * MODAL_CLONE_TRANSFER_REFERENCE_MS
  );
}

export function cloneRampSlackMs(bufferMs: number): number {
  return Math.max(
    MODAL_CLONE_RAMP_SLACK_MIN_MS,
    Math.ceil(Math.max(0, bufferMs) * MODAL_CLONE_RAMP_SLACK_RATIO)
  );
}

/**
 * Listener-facing wall of one call.
 *
 * A batch returns every row together, so this is the whole call: restore
 * (only when this call is the one that brings the container up), generation
 * at {@link cloneRowCharsPerSecond}, and transfer at the smoke's 12s /
 * 43,907-character rate. Publish of a returned call overlaps the next GPU
 * call and is not added here. The HTTP cap is a separate number (`waitMs`).
 */
export function cloneCallWallMs(input: {
  chars: number;
  largestRow: number;
  rows: number;
  shape: CloneWaveShape;
  restore: boolean;
}): number {
  const restore = input.restore ? MODAL_CLONE_RESTORE_EXPECTED_MS : 0;
  // A row never goes faster than the single-row rate, even inside a batch
  // whose average says the page would. The curve is the page; the row is the floor.
  const work = Math.max(
    cloneGenerationMs(input.chars, input.rows),
    cloneGenerationMs(input.largestRow, 1)
  );
  return restore + work + cloneTransferMs(input.chars);
}

/**
 * True when this call finishes and still leaves {@link cloneRampSlackMs}
 * of audio. One row used to pass on any positive spare, which is how a
 * 4.3s margin counted as success.
 */
export function cloneCallFitsBuffer(wallMs: number, bufferMs: number, rows: number): boolean {
  if (!(bufferMs > 0) || !(wallMs >= 0) || !(rows > 0)) return false;
  return wallMs + cloneRampSlackMs(bufferMs) <= bufferMs;
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
  /**
   * Wall from dispatch until this audio can be heard. A batch returns every
   * row together, so this is the whole call, not one row of it.
   */
  wallMs: number;
  /** Audio this call adds once it returns. */
  audioMs: number;
  /** Buffered audio ahead of the listener when this call is dispatched. */
  bufferAtDispatchMs: number;
  /**
   * False when the listener is already playing and this call runs longer
   * than the audio they have left. The ramp does not plan that on purpose.
   * A cold restore that is the only way forward can still be one.
   */
  fitsBuffer: boolean;
};

export type CloneBookWavePlan = {
  calls: CloneWaveCall[];
  deferred: number[];
  /** One restored GPU. Calls in `calls` run in order, never together. */
  parallelLanes: 1;
  /** Listener buffer after every call in this plan has returned. */
  bufferAfterMs: number;
  /** True once this plan has delivered audio the listener can start on. */
  playbackStarted: boolean;
};

export type CloneBookWaveInput = {
  pending: number[];
  textAt: (index: number) => string;
  firstLight: boolean;
  poolWarm: boolean;
  batch: number;
  gpuBusy?: boolean;
  /**
   * Audio already delivered and not yet played, at 1×. Omit on the first
   * call of a book. A later tick that omits this is treated as no buffer,
   * so it does not jump to a 24-row call.
   */
  bufferedMs?: number;
  /** The listener has already heard audio from this book. */
  playbackStarted?: boolean;
  /** Stop after this many calls. One, when the GPU has to be handed back. */
  maxCalls?: number;
  env?: NodeJS.ProcessEnv;
};

type ListenerState = {
  started: boolean;
  buffer: number;
};

/**
 * One book's next GPU calls.
 *
 * The first section is its own call, so a restore can finish and the
 * listener has something to play. Each call after that is the largest
 * prefix that finishes, with margin, before that buffered audio runs out.
 * A batch returns every row together, so the time-to-next-audio is the
 * whole call. The prefix grows as the buffer grows — one row, then a
 * handful, then a full batch — and the calls run back to back.
 *
 * A listener who has not started yet does not constrain the first call.
 * When the container has been idle longer than scaledown, the tick is one
 * cold-sized call and the rest waits. The ramp starts again on the tick
 * after that call returns.
 *
 * `gpuBusy` means another book already has this GPU. Nothing is sent.
 */
export function planModalCloneBookWave(input: CloneBookWaveInput): CloneBookWavePlan {
  const env = input.env ?? process.env;
  const pending = [...input.pending].sort((a, b) => a - b);
  const state: ListenerState = {
    started: input.playbackStarted === true,
    buffer: input.playbackStarted === true ? Math.max(0, input.bufferedMs ?? 0) : 0,
  };
  if (input.gpuBusy || pending.length === 0) {
    return {
      calls: [],
      deferred: pending,
      parallelLanes: 1,
      bufferAfterMs: state.buffer,
      playbackStarted: state.started,
    };
  }

  const calls: CloneWaveCall[] = [];
  let rest = pending;
  const batch = Math.max(1, Math.floor(input.batch));
  const maxCalls =
    typeof input.maxCalls === "number" && input.maxCalls > 0
      ? Math.floor(input.maxCalls)
      : Number.POSITIVE_INFINITY;

  if (input.firstLight && rest.length > 0 && calls.length < maxCalls) {
    const head = rest[0]!;
    rest = rest.slice(1);
    pushCall(calls, state, describeCloneWaveCall({
      indexes: [head],
      shape: "cold",
      firstLight: true,
      restore: !input.poolWarm,
      textAt: input.textAt,
      env,
      state,
    }));
  }

  // The container is cold and this tick is not the one that plays section 0.
  // One small call, then stop. The ramp waits until that call has returned
  // and the next tick sees a warm pool. Planning a fat tail behind a restore
  // that might not happen is how a book pays for the same rows twice.
  if (!input.firstLight && !input.poolWarm && rest.length > 0 && calls.length < maxCalls) {
    const packed = planModalCloneLanes({
      pending: rest,
      textAt: input.textAt,
      limits: { lanes: 1, batch, maxLaneChars: modalLaneCharLimit(env) },
    });
    const lane = packed.lanes[0];
    if (lane && lane.length > 0) {
      pushCall(calls, state, describeCloneWaveCall({
        indexes: lane,
        shape: "cold",
        firstLight: false,
        restore: true,
        textAt: input.textAt,
        env,
        state,
      }));
      rest = packed.deferred;
    }
    return finishPlan(calls, rest, state);
  }

  const warm = input.firstLight || input.poolWarm;
  if (warm) {
    while (rest.length > 0 && calls.length < maxCalls) {
      const prefix = largestWarmPrefix(rest, state, batch, input.textAt, env);
      // No prefix means even one row overruns the buffer. Send that row
      // anyway when the listener is already waiting on it: it is the only
      // way the book moves, and the playback sim records the stall.
      // Before the listener has started, one row is the first audio.
      const indexes = prefix ?? [rest[0]!];
      pushCall(calls, state, describeCloneWaveCall({
        indexes,
        shape: "warm",
        firstLight: false,
        restore: false,
        textAt: input.textAt,
        env,
        state,
        fitsBuffer: prefix != null || !state.started,
      }));
      rest = rest.slice(indexes.length);
      if (!prefix) break;
    }
  }

  return finishPlan(calls, rest, state);
}

/**
 * Largest prefix of `rest` whose wall finishes inside the listener's
 * buffer, the warm character cap, the 80 MiB body, and the warm HTTP wait.
 * Null when even the first section overruns the buffer.
 */
function largestWarmPrefix(
  rest: number[],
  state: ListenerState,
  batch: number,
  textAt: (index: number) => string,
  env: NodeJS.ProcessEnv
): number[] | null {
  if (!state.started) {
    // Nothing is playing yet. One section is the first audio; a wider
    // call would hold that audio until the last row of the call returns.
    return rest.slice(0, 1);
  }
  const charCap = modalWarmLaneCharLimit(env);
  const waitCap = modalCloneWarmWaitMs(env);
  // The call that follows section 0 is one short row. A deeper buffer is
  // what unlocks the rest of the ramp. Comparing to the opening's audio,
  // plus a second, still matches a section that closed a little long.
  const openingCall =
    state.buffer <= cloneAudioMs(MODAL_CLONE_OPENING_SECTION_CHARS) + 1_000;
  let best = 0;
  let chars = 0;
  let largest = 0;
  const limit = Math.min(batch, rest.length);
  for (let n = 1; n <= limit; n += 1) {
    const size = textAt(rest[n - 1]!).length;
    const nextChars = chars + size;
    const nextLargest = Math.max(largest, size);
    if (openingCall && n > 1 && nextChars > MODAL_CLONE_SECOND_CALL_CHARS) break;
    if (n > 1 && nextChars > charCap) break;
    if (n > 1 && estimateCloneBatchJsonBytes(nextChars) > MODAL_CLONE_RESPONSE_BODY_MAX_BYTES) {
      break;
    }
    const wall = cloneCallWallMs({
      chars: nextChars,
      largestRow: nextLargest,
      rows: n,
      shape: "warm",
      restore: false,
    });
    if (n > 1 && (wall >= waitCap || wall >= MODAL_CLONE_PROXY_KILL_MS)) break;
    if (!cloneCallFitsBuffer(wall, state.buffer, n)) break;
    best = n;
    chars = nextChars;
    largest = nextLargest;
  }
  return best > 0 ? rest.slice(0, best) : null;
}

function pushCall(calls: CloneWaveCall[], state: ListenerState, call: CloneWaveCall): void {
  calls.push(call);
  if (!state.started) {
    state.started = true;
    state.buffer = call.audioMs;
    return;
  }
  state.buffer = Math.max(0, state.buffer - call.wallMs) + call.audioMs;
}

function finishPlan(
  calls: CloneWaveCall[],
  rest: number[],
  state: ListenerState
): CloneBookWavePlan {
  return {
    calls,
    deferred: rest,
    parallelLanes: 1,
    bufferAfterMs: state.buffer,
    playbackStarted: state.started,
  };
}

function describeCloneWaveCall(input: {
  indexes: number[];
  shape: CloneWaveShape;
  firstLight: boolean;
  restore: boolean;
  textAt: (index: number) => string;
  env: NodeJS.ProcessEnv;
  state: ListenerState;
  fitsBuffer?: boolean;
}): CloneWaveCall {
  let chars = 0;
  let largest = 0;
  for (const index of input.indexes) {
    const size = input.textAt(index).length;
    chars += size;
    if (size > largest) largest = size;
  }
  const workMs = Math.max(cloneGenerationMs(chars, input.indexes.length), cloneGenerationMs(largest, 1));
  const need = workMs + MODAL_CLONE_CALL_PREP_MS;
  const waitMs =
    input.shape === "warm"
      ? modalCloneWarmWaitMs(input.env)
      : Math.min(
          MODAL_CLONE_COLD_WAIT_MAX_MS,
          Math.max(
            input.firstLight ? modalCloneFirstLightWaitMs(input.env) : modalCloneColdWaitMs(input.env),
            need
          )
        );
  const wallMs = cloneCallWallMs({
    chars,
    largestRow: largest,
    rows: input.indexes.length,
    shape: input.shape,
    restore: input.restore,
  });
  const drains = input.state.started;
  const fits =
    input.fitsBuffer ??
    (!drains || cloneCallFitsBuffer(wallMs, input.state.buffer, input.indexes.length));
  return {
    indexes: [...input.indexes],
    shape: input.shape,
    chars,
    workMs,
    waitMs,
    wallMs,
    audioMs: cloneAudioMs(chars),
    bufferAtDispatchMs: drains ? input.state.buffer : 0,
    fitsBuffer: fits,
  };
}

export type CloneListener = {
  id: string;
  pending: number[];
  textAt: (index: number) => string;
  playbackStarted: boolean;
  bufferedMs: number;
  /** The next call is this book's first audio. */
  firstLight: boolean;
};

export type CloneGpuTurn = {
  bookId: string | null;
  call: CloneWaveCall | null;
};

/**
 * Who may use the one GPU next, and the one call they may send.
 *
 * A call is legal when it finishes before the speaker's buffer runs out
 * and every other listener who has already started still has enough audio
 * left to cover their own next section. The book closer to a stall goes
 * first. A book that has not started gets the GPU only when taking it
 * does not drop a listener below that next section. Calls are never
 * concurrent: the caller runs this again when the call returns.
 */
export function chooseCloneGpuTurn(input: {
  books: CloneListener[];
  poolWarm: boolean;
  batch: number;
  env?: NodeJS.ProcessEnv;
}): CloneGpuTurn {
  const env = input.env ?? process.env;
  const batch = Math.max(1, Math.floor(input.batch));
  const books = input.books.filter((book) => book.pending.length > 0);
  if (books.length === 0) return { bookId: null, call: null };

  const started = books.filter((book) => book.playbackStarted);

  // A listener who has not heard anything yet goes first, once the books
  // already playing can spare this one section and still cover their own
  // next one. Otherwise a deep buffer on the active book would take a full
  // batch and leave the second listener waiting through it.
  for (const book of books) {
    if (book.playbackStarted) continue;
    const call = firstSectionCall(book, input.poolWarm, env);
    if (!unstartedCallIsSafe(book, call, started)) continue;
    return { bookId: book.id, call };
  }

  const legal: Array<{ book: CloneListener; call: CloneWaveCall; slack: number }> = [];

  for (const book of started) {
    const others = started.filter((other) => other.id !== book.id);
    const call = largestSharedPrefix(book, others, batch, env);
    if (!call) continue;
    const next = nextSectionWall(book, call.indexes.length, true);
    legal.push({
      book,
      call,
      slack: book.bufferedMs - call.wallMs - next,
    });
  }

  if (legal.length > 0) {
    legal.sort((a, b) => a.slack - b.slack);
    const winner = legal[0]!;
    return { bookId: winner.book.id, call: winner.call };
  }

  // Nobody has a call that keeps every listener ahead of their next
  // section. The book closest to silence still has to move, or both wait
  // forever. The playback sim counts this as a stall.
  if (started.length > 0) {
    const closest = [...started].sort((a, b) => a.bufferedMs - b.bufferedMs)[0]!;
    const call = firstSectionCall(closest, true, env);
    return {
      bookId: closest.id,
      call: { ...call, fitsBuffer: cloneCallFitsBuffer(call.wallMs, closest.bufferedMs, 1) },
    };
  }

  const first = books[0]!;
  return { bookId: first.id, call: firstSectionCall(first, input.poolWarm, env) };
}

function firstSectionCall(
  book: CloneListener,
  poolWarm: boolean,
  env: NodeJS.ProcessEnv
): CloneWaveCall {
  const state: ListenerState = {
    started: book.playbackStarted,
    buffer: book.playbackStarted ? book.bufferedMs : 0,
  };
  // A book's first audio stays one section even on a warm pool, so the
  // other listener is not asked to sit through a batch before this one
  // has anything to play. A later section on a book that has already
  // started is one warm row: the caller only uses this when a wider
  // prefix does not fit.
  const opening = book.firstLight && !book.playbackStarted;
  return describeCloneWaveCall({
    indexes: [book.pending[0]!],
    shape: opening ? "cold" : "warm",
    firstLight: opening,
    restore: opening && !poolWarm,
    textAt: book.textAt,
    env,
    state,
  });
}

function nextSectionWall(book: CloneListener, skip: number, poolWarm: boolean): number {
  const index = book.pending[skip];
  if (index == null) return 0;
  const chars = book.textAt(index).length;
  return cloneCallWallMs({
    chars,
    largestRow: chars,
    rows: 1,
    shape: poolWarm ? "warm" : "cold",
    restore: false,
  });
}

/**
 * Largest warm prefix that fits the speaker and leaves every other
 * listener enough audio for their own next section.
 */
function largestSharedPrefix(
  book: CloneListener,
  others: CloneListener[],
  batch: number,
  env: NodeJS.ProcessEnv
): CloneWaveCall | null {
  const state: ListenerState = { started: true, buffer: book.bufferedMs };
  const prefix = largestWarmPrefix(book.pending, state, batch, book.textAt, env);
  if (!prefix) return null;
  let best: number[] | null = null;
  for (let n = 1; n <= prefix.length; n += 1) {
    const indexes = prefix.slice(0, n);
    const call = describeCloneWaveCall({
      indexes,
      shape: "warm",
      firstLight: false,
      restore: false,
      textAt: book.textAt,
      env,
      state,
    });
    if (!others.every((other) => otherSurvives(other, call.wallMs))) continue;
    const speakerNext = nextSectionWall(book, n, true);
    const speakerAfter = book.bufferedMs - call.wallMs + call.audioMs;
    if (speakerNext > 0 && speakerAfter < speakerNext + cloneRampSlackMs(speakerAfter)) continue;
    best = indexes;
  }
  if (!best) return null;
  return describeCloneWaveCall({
    indexes: best,
    shape: "warm",
    firstLight: false,
    restore: false,
    textAt: book.textAt,
    env,
    state,
  });
}

function otherSurvives(other: CloneListener, wallMs: number): boolean {
  if (!other.playbackStarted) return true;
  const slack = cloneRampSlackMs(other.bufferedMs);
  if (other.bufferedMs - wallMs < slack) return false;
  const next = nextSectionWall(other, 0, true);
  if (next <= 0) return true;
  return other.bufferedMs - wallMs - next >= slack;
}

function unstartedCallIsSafe(
  book: CloneListener,
  call: CloneWaveCall,
  started: CloneListener[]
): boolean {
  const next = nextSectionWall(book, 1, true);
  if (next > 0 && call.audioMs < next + cloneRampSlackMs(call.audioMs)) return false;
  return started.every((other) => otherSurvives(other, call.wallMs));
}

/**
 * Two books, one GPU, one turn. The book that gets the call is the one
 * {@link chooseCloneGpuTurn} picks. The other sends nothing until this
 * call returns.
 */
export function planTwoBooksOnOneGpu(input: {
  active: {
    id?: string;
    pending: number[];
    textAt: (index: number) => string;
    firstLight: boolean;
    poolWarm: boolean;
    playbackStarted?: boolean;
    bufferedMs?: number;
  };
  waiting: {
    id?: string;
    pending: number[];
    textAt: (index: number) => string;
    firstLight: boolean;
    poolWarm: boolean;
    playbackStarted?: boolean;
    bufferedMs?: number;
  };
  batch: number;
  env?: NodeJS.ProcessEnv;
}): { active: CloneBookWavePlan; waiting: CloneBookWavePlan } {
  const activeId = input.active.id ?? "active";
  const waitingId = input.waiting.id ?? "waiting";
  const poolWarm = input.active.poolWarm || input.waiting.poolWarm;
  const turn = chooseCloneGpuTurn({
    books: [
      listenerFrom(activeId, input.active),
      listenerFrom(waitingId, input.waiting),
    ],
    poolWarm,
    batch: input.batch,
    env: input.env,
  });
  return {
    active: planForTurn(activeId, input.active, turn),
    waiting: planForTurn(waitingId, input.waiting, turn),
  };
}

function listenerFrom(
  id: string,
  book: {
    pending: number[];
    textAt: (index: number) => string;
    firstLight: boolean;
    playbackStarted?: boolean;
    bufferedMs?: number;
  }
): CloneListener {
  return {
    id,
    pending: book.pending,
    textAt: book.textAt,
    playbackStarted: book.playbackStarted === true,
    bufferedMs: book.playbackStarted === true ? Math.max(0, book.bufferedMs ?? 0) : 0,
    firstLight: book.firstLight,
  };
}

function planForTurn(
  id: string,
  book: {
    pending: number[];
    textAt: (index: number) => string;
    playbackStarted?: boolean;
    bufferedMs?: number;
  },
  turn: CloneGpuTurn
): CloneBookWavePlan {
  const pending = [...book.pending].sort((a, b) => a - b);
  if (turn.bookId !== id || !turn.call) {
    return {
      calls: [],
      deferred: pending,
      parallelLanes: 1,
      bufferAfterMs: book.playbackStarted ? Math.max(0, book.bufferedMs ?? 0) : 0,
      playbackStarted: book.playbackStarted === true,
    };
  }
  const taken = new Set(turn.call.indexes);
  const state: ListenerState = {
    started: book.playbackStarted === true,
    buffer: book.playbackStarted === true ? Math.max(0, book.bufferedMs ?? 0) : 0,
  };
  const calls: CloneWaveCall[] = [];
  pushCall(calls, state, turn.call);
  return finishPlan(
    calls,
    pending.filter((index) => !taken.has(index)),
    state
  );
}

export type ClonePlaybackStep = {
  bookId: string;
  rows: number;
  chars: number;
  shape: CloneWaveShape;
  wallMs: number;
  audioMs: number;
  bufferAtDispatchMs: number;
  fitsBuffer: boolean;
};

export type ClonePlaybackReport = {
  steps: ClonePlaybackStep[];
  /** Wall from the start of the sim until this book's first audio returns. */
  timeToFirstAudioMs: number;
  totalWallMs: number;
  stallCount: number;
  sizeSequence: number[];
  /**
   * Smallest (buffer − call wall) once playback has started, in ms.
   * The opening call is not included: nothing is playing yet.
   */
  minMarginMs: number;
};

/**
 * Play one book at 1× from the moment its first audio returns.
 *
 * Each tick claims `claim` sections (the worker's batch window) and
 * pipelines the ramp inside that window. The clock does not idle between
 * calls. A stall is a call that starts while the listener is already
 * playing and runs longer than the audio they have left.
 */
export function simulateClonePlayback(input: {
  sectionChars: number[];
  batch?: number;
  claim?: number;
  env?: NodeJS.ProcessEnv;
}): ClonePlaybackReport {
  const env = input.env ?? process.env;
  const batch = input.batch ?? 24;
  const claim = input.claim ?? batch;
  const charsAt = input.sectionChars;
  let pending = charsAt.map((_, index) => index);
  let poolWarm = false;
  let started = false;
  let buffer = 0;
  let clock = 0;
  let timeToFirstAudioMs = 0;
  const steps: ClonePlaybackStep[] = [];
  let guard = 0;
  while (pending.length > 0 && guard < charsAt.length + 5) {
    guard += 1;
    const window = pending.slice(0, claim);
    const plan = planModalCloneBookWave({
      pending: window,
      textAt: (index) => "x".repeat(charsAt[index] ?? 0),
      firstLight: window[0] === 0 && !started,
      poolWarm,
      batch,
      bufferedMs: buffer,
      playbackStarted: started,
      env,
    });
    if (plan.calls.length === 0) break;
    for (const call of plan.calls) {
      steps.push({
        bookId: "book",
        rows: call.indexes.length,
        chars: call.chars,
        shape: call.shape,
        wallMs: call.wallMs,
        audioMs: call.audioMs,
        bufferAtDispatchMs: call.bufferAtDispatchMs,
        fitsBuffer: call.fitsBuffer,
      });
      clock += call.wallMs;
      // The first call is the one the listener is waiting on. Later calls
      // in the same plan run after that audio has started.
      if (timeToFirstAudioMs === 0) timeToFirstAudioMs = clock;
    }
    started = plan.playbackStarted;
    buffer = plan.bufferAfterMs;
    poolWarm = true;
    const taken = new Set(plan.calls.flatMap((call) => call.indexes));
    pending = pending.filter((index) => !taken.has(index));
  }
  const margins = steps.slice(1).map((step) => step.bufferAtDispatchMs - step.wallMs);
  return {
    steps,
    timeToFirstAudioMs,
    totalWallMs: clock,
    stallCount: steps.filter((step) => !step.fitsBuffer).length,
    sizeSequence: steps.map((step) => step.rows),
    minMarginMs: margins.length > 0 ? Math.min(...margins) : 0,
  };
}

/**
 * Two books, one GPU, both listened to at 1× from their own first audio.
 * Calls never overlap. The book closer to a stall is served, and a book
 * that has not started is served only when every current listener still
 * has a next section's worth of audio afterwards.
 */
export function simulateTwoCloneListeners(input: {
  books: Array<{ id: string; sectionChars: number[] }>;
  batch?: number;
  env?: NodeJS.ProcessEnv;
}): {
  reports: ClonePlaybackReport[];
  totalWallMs: number;
  overlapping: boolean;
} {
  const env = input.env ?? process.env;
  const batch = input.batch ?? 24;
  const states = input.books.map((book) => ({
    id: book.id,
    chars: book.sectionChars,
    next: 0,
    started: false,
    buffer: 0,
    clockAtStart: 0,
    steps: [] as ClonePlaybackStep[],
    minMarginMs: Number.POSITIVE_INFINITY,
    drained: 0,
  }));
  let poolWarm = false;
  let clock = 0;
  let guard = 0;
  const totalSections = states.reduce((sum, book) => sum + book.chars.length, 0);
  while (states.some((book) => book.next < book.chars.length) && guard < totalSections + 5) {
    guard += 1;
    const turn = chooseCloneGpuTurn({
      books: states
        .filter((book) => book.next < book.chars.length)
        .map((book) => ({
          id: book.id,
          pending: book.chars.slice(book.next).map((_, offset) => book.next + offset),
          textAt: (index) => "x".repeat(book.chars[index] ?? 0),
          playbackStarted: book.started,
          bufferedMs: book.buffer,
          firstLight: book.next === 0,
        })),
      poolWarm,
      batch,
      env,
    });
    if (!turn.call || !turn.bookId) break;
    const book = states.find((item) => item.id === turn.bookId);
    if (!book) break;
    book.steps.push({
      bookId: book.id,
      rows: turn.call.indexes.length,
      chars: turn.call.chars,
      shape: turn.call.shape,
      wallMs: turn.call.wallMs,
      audioMs: turn.call.audioMs,
      bufferAtDispatchMs: turn.call.bufferAtDispatchMs,
      fitsBuffer: turn.call.fitsBuffer,
    });
    for (const other of states) {
      if (!other.started || other.id === book.id) continue;
      const left = other.buffer - turn.call.wallMs;
      other.minMarginMs = Math.min(other.minMarginMs, left);
      if (left < 0) other.drained += 1;
      other.buffer = Math.max(0, left);
    }
    clock += turn.call.wallMs;
    if (!book.started) book.clockAtStart = clock;
    if (book.started) {
      book.minMarginMs = Math.min(book.minMarginMs, book.buffer - turn.call.wallMs);
      book.buffer = Math.max(0, book.buffer - turn.call.wallMs) + turn.call.audioMs;
    } else {
      book.started = true;
      book.buffer = turn.call.audioMs;
    }
    book.next += turn.call.indexes.length;
    poolWarm = true;
  }
  return {
    reports: states.map((book) => ({
      steps: book.steps,
      timeToFirstAudioMs: book.clockAtStart,
      totalWallMs: clock,
      stallCount:
        book.steps.filter((step) => !step.fitsBuffer).length + book.drained,
      sizeSequence: book.steps.map((step) => step.rows),
      minMarginMs: Number.isFinite(book.minMarginMs) ? book.minMarginMs : 0,
    })),
    totalWallMs: clock,
    // The loop runs one call to the clock before choosing the next, so two
    // books never have a call in flight together.
    overlapping: false,
  };
}
