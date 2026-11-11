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
  modalCloneCallTimeoutMs,
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
 * planned cold wall is ~72s once the section loudnorm is counted.
 */
export const MODAL_CLONE_OPENING_SECTION_CHARS = 1_000;

/**
 * The call after section 0 used to be a fixed 1,300 characters. At 1.5×
 * that row finishes after the opening's spare (the 1× margin of ~17s is
 * about 11s at 1.5×, under the 15s floor). {@link modalCloneSecondCallChars}
 * is the largest one-row warm call that still leaves the floor against
 * section 0's audio at {@link MODAL_CLONE_LISTENER_RATE}. Growing section 0
 * enough to cover 1,300 characters at that rate would pass the 75s
 * first-light wait once publish is in the wall, so section 0 stays 1,000.
 */

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
 * at {@link cloneRowCharsPerSecond}, transfer at the smoke's 12s /
 * 43,907-character rate, and the section loudnorm that runs before the
 * player can read the take ({@link MODAL_CLONE_PUBLISH_MS}). The HTTP cap
 * is a separate number (`waitMs`), and a cold call is only planned when
 * this wall is strictly under the wait that cap will arm.
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
  return restore + work + cloneTransferMs(input.chars) + MODAL_CLONE_PUBLISH_MS;
}

/**
 * Section loudnorm on the app, about 2–3s, before the take is playable.
 * It is part of the listener's wait for this call, so the ramp counts it.
 */
export const MODAL_CLONE_PUBLISH_MS = 3_000;

/**
 * The player's fastest listen rate (`PLAYBACK_SPEED` max, 1.5×).
 * One planning unit is one millisecond of wall time the listener still
 * has: `delivered / 1.5 − elapsed`. A call subtracts its wall directly.
 * A seek ahead of the delivered audio is already zero.
 */
export const MODAL_CLONE_LISTENER_RATE = 1.5;

/**
 * Wall time a stretch of 1× audio lasts at {@link MODAL_CLONE_LISTENER_RATE}.
 * Pass audio duration only. A value that already subtracted wall time is
 * a different unit and must not be divided again.
 */
export function clonePlanningBufferMs(audioMs: number): number {
  if (!(audioMs > 0)) return 0;
  return Math.floor(audioMs / MODAL_CLONE_LISTENER_RATE);
}

/**
 * Planning buffer after a call returns.
 *
 * `bufferMs` is wall time left. The call consumes that much wall, and the
 * audio it adds lasts `audioMs / 1.5` of wall at the listener's fastest
 * rate. Seeking does not add buffer: this only shrinks, then adds the take.
 */
export function advancePlanningBuffer(
  bufferMs: number,
  wallMs: number,
  audioMs: number
): number {
  return Math.max(0, bufferMs - Math.max(0, wallMs)) + clonePlanningBufferMs(audioMs);
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
 * Largest warm one-row call that leaves {@link MODAL_CLONE_RAMP_SLACK_MIN_MS}
 * against section 0 played at {@link MODAL_CLONE_LISTENER_RATE}.
 */
/** Largest warm one-row call that still leaves the slack inside `bufferMs`. */
export function modalCloneRowCharsThatFit(bufferMs: number): number {
  if (!(bufferMs > 0)) return 0;
  const slack = cloneRampSlackMs(bufferMs);
  let best = 0;
  for (let chars = 1; chars <= MODAL_CLONE_SECTION_CHARS_DEFAULT; chars += 1) {
    const wall = cloneCallWallMs({
      chars,
      largestRow: chars,
      rows: 1,
      shape: "warm",
      restore: false,
    });
    if (wall + slack <= bufferMs) best = chars;
    else break;
  }
  return best;
}

/**
 * Section 1 for an opening of exactly {@link MODAL_CLONE_OPENING_SECTION_CHARS}.
 * A real opening closes on a sentence and can be a little shorter, so the
 * packer uses {@link modalCloneSecondCallCharsFor} with that length.
 */
export function modalCloneSecondCallChars(): number {
  return modalCloneSecondCallCharsFor(MODAL_CLONE_OPENING_SECTION_CHARS);
}

/** Section 1 that leaves the slack against this opening's audio at 1.5×. */
export function modalCloneSecondCallCharsFor(openingChars: number): number {
  return modalCloneNextSectionChars([openingChars]);
}

/**
 * Largest warm one-row call that still leaves the slack after section 0
 * and {@link modalCloneSecondCallChars} have played at 1.5×. A 2,000-character
 * row does not fit that buffer. The section after this one does.
 */
export function modalCloneThirdCallChars(): number {
  return modalCloneThirdCallCharsFor(
    MODAL_CLONE_OPENING_SECTION_CHARS,
    modalCloneSecondCallChars()
  );
}

/**
 * Section 2 after this opening and this second section have played at 1.5×.
 * A shorter real opening leaves a smaller buffer than the 1,000-character plan.
 */
export function modalCloneThirdCallCharsFor(
  openingChars: number,
  secondChars: number
): number {
  return modalCloneNextSectionChars([openingChars, secondChars]);
}

/**
 * The wait `modalCloneCallWait` arms. One function, so the planner and the
 * abort cannot disagree. `workMs` for a cold call is {@link cloneCallWallMs}.
 */
export function modalCloneArmedWaitMs(
  poolKnownWarm: boolean,
  raceForFirstAudio = false,
  workMs = 0,
  warmBatch = false
): { ms: number; kind: "restore" | "steady" | "warm" } {
  if (warmBatch) {
    return { ms: modalCloneWarmWaitMs(), kind: "warm" };
  }
  const work = Number.isFinite(workMs) && workMs > 0 ? workMs : 0;
  const need = work + MODAL_CLONE_CALL_PREP_MS;
  if (poolKnownWarm) {
    return {
      ms: Math.min(
        MODAL_CLONE_COLD_WAIT_MAX_MS,
        Math.max(modalCloneCallTimeoutMs(), need)
      ),
      kind: "steady",
    };
  }
  const restore = Math.max(modalCloneColdWaitMs(), modalCloneCallTimeoutMs(), need);
  return {
    ms: Math.min(
      MODAL_CLONE_COLD_WAIT_MAX_MS,
      raceForFirstAudio
        ? Math.min(restore, Math.max(modalCloneFirstLightWaitMs(), need))
        : restore
    ),
    kind: "restore",
  };
}

/**
 * A cold pack is legal only when its listener wall is strictly under the
 * wait the abort will arm for that same wall. A 7,700-character row is not.
 */
export function coldClonePackFitsAbort(input: {
  chars: number;
  largestRow: number;
  rows: number;
  raceForFirstAudio: boolean;
}): { wallMs: number; abortMs: number; fits: boolean } {
  const wallMs = cloneCallWallMs({
    chars: input.chars,
    largestRow: input.largestRow,
    rows: input.rows,
    shape: "cold",
    restore: true,
  });
  const abortMs = modalCloneArmedWaitMs(
    false,
    input.raceForFirstAudio,
    wallMs,
    false
  ).ms;
  return { wallMs, abortMs, fits: wallMs < abortMs };
}

/** Largest single cold row whose wall still finishes inside the armed abort. */
export function modalCloneColdSafeRowChars(): number {
  let best = 0;
  for (let chars = 100; chars <= 8_000; chars += 10) {
    if (
      coldClonePackFitsAbort({
        chars,
        largestRow: chars,
        rows: 1,
        raceForFirstAudio: false,
      }).fits
    ) {
      best = chars;
    } else break;
  }
  return best;
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

/**
 * Wall time left after these sections have played back to back at 1.5×.
 * Section 0's own wall is not subtracted: playback starts when it returns.
 * Each later call subtracts its wall, then adds the audio it delivered.
 */
export function planningBufferAfterSections(chars: number[]): number {
  if (chars.length === 0) return 0;
  let buffer = clonePlanningBufferMs(cloneAudioMs(chars[0]!));
  for (let i = 1; i < chars.length; i += 1) {
    const size = chars[i]!;
    const wall = cloneCallWallMs({
      chars: size,
      largestRow: size,
      rows: 1,
      shape: "warm",
      restore: false,
    });
    buffer = advancePlanningBuffer(buffer, wall, cloneAudioMs(size));
  }
  return buffer;
}

/**
 * Largest one-row section that still leaves {@link cloneRampSlackMs} after
 * `prior` has played at 1.5×. The steady width is
 * {@link MODAL_CLONE_SECTION_CHARS_DEFAULT}; earlier rows are shorter
 * because a 2,000-character row does not fit the opening.
 */
export function modalCloneNextSectionChars(prior: number[]): number {
  if (prior.length === 0) return MODAL_CLONE_OPENING_SECTION_CHARS;
  const fit = modalCloneRowCharsThatFit(planningBufferAfterSections(prior));
  if (fit <= 0) return 0;
  return Math.min(MODAL_CLONE_SECTION_CHARS_DEFAULT, fit);
}

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
   * Wall time left at 1.5×: delivered audio / 1.5, minus elapsed wall.
   * Omit on the first call of a book. A later tick that omits this is
   * treated as no buffer, so it does not jump to a 24-row call.
   */
  bufferedMs?: number;
  /** The listener has already heard audio from this book. */
  playbackStarted?: boolean;
  /**
   * `pending` is every section this book still has to speak. A claim window
   * that stopped early is not the whole book, and a short-piece batch is
   * not sent for a prefix of a longer one.
   */
  entireRemainder?: boolean;
  /** Stop after this many calls. One, when the GPU has to be handed back. */
  maxCalls?: number;
  env?: NodeJS.ProcessEnv;
};

type ListenerState = {
  started: boolean;
  /** Wall time left at 1.5×. A call subtracts its wall from this. */
  buffer: number;
};

function listenerState(started: boolean, planningBuffer: number): ListenerState {
  return {
    started,
    buffer: Math.max(0, planningBuffer),
  };
}

/** Generation time of a call: the page, or its longest row, whichever is slower. */
function cloneCallWorkMs(chars: number, largestRow: number, rows: number): number {
  return Math.max(cloneGenerationMs(chars, rows), cloneGenerationMs(largestRow, 1));
}

/**
 * The whole remaining book as one opening call, or null when that would
 * make first audio later than section 0 alone.
 *
 * Generation has to be no greater than section 0. Transfer of the extra
 * text is the only added wait. With these section widths that holds up to
 * about 1,959 characters: a 1,000-character opening and a second section of
 * 959. Two rows at the smoke curve are a little slower per row than one
 * row at 33 chars/s, so a second section of 1,000 already adds generation.
 * 1,959 characters is ~124s of audio, about 2.1 minutes. The extra transfer
 * there is under half a second, and the book is one call instead of two,
 * so total time is shorter.
 *
 * A 1,300-character second section, or any 2,000-character row, adds
 * generation. A 5-minute article contains one of those rows, and a cold
 * batch of it returns around 100s rather than the ramp's ~69s, so it ramps.
 * Ten minutes of audio would fit inside that ~69s only if every row were a
 * few hundred characters and they ran in parallel. These rows are not.
 */
function shortOpeningIndexes(
  pending: number[],
  poolWarm: boolean,
  batch: number,
  textAt: (index: number) => string,
  env: NodeJS.ProcessEnv
): number[] | null {
  if (pending.length < 2 || pending.length > batch) return null;
  let chars = 0;
  let largest = 0;
  let head = 0;
  for (let i = 0; i < pending.length; i += 1) {
    const size = textAt(pending[i]!).length;
    if (i === 0) head = size;
    chars += size;
    if (size > largest) largest = size;
  }
  if (!(head > 0)) return null;
  if (cloneCallWorkMs(chars, largest, pending.length) > cloneCallWorkMs(head, head, 1)) {
    return null;
  }
  const charCap = poolWarm ? modalWarmLaneCharLimit(env) : modalLaneCharLimit(env);
  if (chars > charCap) return null;
  if (estimateCloneBatchJsonBytes(chars) > MODAL_CLONE_RESPONSE_BODY_MAX_BYTES) return null;
  const wall = cloneCallWallMs({
    chars,
    largestRow: largest,
    rows: pending.length,
    shape: "cold",
    restore: !poolWarm,
  });
  const waitCap = modalCloneFirstLightWaitMs(env);
  if (wall >= waitCap || wall >= MODAL_CLONE_PROXY_KILL_MS) return null;
  if (!poolWarm) {
    const verdict = coldClonePackFitsAbort({
      chars,
      largestRow: largest,
      rows: pending.length,
      raceForFirstAudio: true,
    });
    if (!verdict.fits) return null;
  }
  return [...pending];
}

/** Drop rows from the end until the cold pack finishes inside its abort. */
function coldIndexesThatFinish(
  lane: number[],
  textAt: (index: number) => string,
  raceForFirstAudio: boolean
): number[] | null {
  const indexes = [...lane];
  while (indexes.length > 0) {
    let chars = 0;
    let largest = 0;
    for (const index of indexes) {
      const size = textAt(index).length;
      chars += size;
      if (size > largest) largest = size;
    }
    if (
      coldClonePackFitsAbort({
        chars,
        largestRow: largest,
        rows: indexes.length,
        raceForFirstAudio,
      }).fits
    ) {
      return indexes;
    }
    indexes.pop();
  }
  return null;
}

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
 * A listener who has not started yet does not constrain the first call,
 * except a short piece: when `pending` is the whole remaining book and one
 * call adds no generation beyond section 0, that call is the book. Extra
 * text still costs its transfer (under half a second at the boundary). A
 * later row longer than the opening adds generation, and the book ramps
 * so first audio stays the opening's ~72s cold / ~34s warm.
 * When the container has been idle longer than scaledown, the tick is one
 * cold-sized call and the rest waits. The ramp starts again on the tick
 * after that call returns.
 *
 * `gpuBusy` means another book already has this GPU. Nothing is sent.
 */
export function planModalCloneBookWave(input: CloneBookWaveInput): CloneBookWavePlan {
  const env = input.env ?? process.env;
  const pending = [...input.pending].sort((a, b) => a - b);
  const state = listenerState(
    input.playbackStarted === true,
    input.playbackStarted === true ? Math.max(0, input.bufferedMs ?? 0) : 0
  );
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

  // A short piece whose rows finish in section 0's generation time. One
  // call, then done. A 2,000-character row does not qualify: it generates
  // for ~61s, so a cold batch would return after the ramp's ~69s.
  if (
    !state.started &&
    input.entireRemainder === true &&
    input.firstLight &&
    rest.length > 1 &&
    calls.length < maxCalls
  ) {
    const whole = shortOpeningIndexes(rest, input.poolWarm, batch, input.textAt, env);
    if (whole && whole.length === rest.length) {
      pushCall(calls, state, describeCloneWaveCall({
        indexes: whole,
        shape: "cold",
        firstLight: true,
        restore: !input.poolWarm,
        textAt: input.textAt,
        env,
        state,
      }));
      return finishPlan(calls, [], state);
    }
  }

  if (input.firstLight && rest.length > 0 && calls.length < maxCalls) {
    const head = rest[0]!;
    const sized = coldIndexesThatFinish([head], input.textAt, true);
    if (!sized) return finishPlan(calls, rest, state);
    rest = rest.slice(1);
    pushCall(calls, state, describeCloneWaveCall({
      indexes: sized,
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
    const sized = lane && lane.length > 0
      ? coldIndexesThatFinish(lane, input.textAt, false)
      : null;
    if (sized && sized.length > 0) {
      pushCall(calls, state, describeCloneWaveCall({
        indexes: sized,
        shape: "cold",
        firstLight: false,
        restore: true,
        textAt: input.textAt,
        env,
        state,
      }));
      const taken = new Set(sized);
      rest = rest.filter((index) => !taken.has(index));
    }
    return finishPlan(calls, rest, state);
  }

  const warm = input.firstLight || input.poolWarm;
  if (warm) {
    while (rest.length > 0 && calls.length < maxCalls) {
      const prefix = largestWarmPrefix(rest, state, batch, input.textAt, env);
      // Before the listener has started, one row is the first audio.
      // A row within one publish of the slack is still sent: the next
      // tick's clock has moved, and refusing it leaves the book queued.
      // A wider miss waits for a re-pack. An empty buffer is a hole, and
      // that one section is sent so the hole can fill.
      const ahead =
        prefix == null ? rowThatStaysAhead(rest, state, input.textAt, env) : null;
      const indexes = prefix ?? (!state.started || state.buffer <= 0 ? [rest[0]!] : ahead);
      if (!indexes) break;
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
 * One warm row that misses the slack by at most one section publish.
 *
 * The next tick's clock has already moved while the previous take was
 * mastered. A sentence that still finishes before the audio runs out, and
 * is within that publish of the 15s line, is sent. A wider miss stays
 * unsent so the outline can be re-packed instead of playing through it.
 */
function rowThatStaysAhead(
  rest: number[],
  state: ListenerState,
  textAt: (index: number) => string,
  env: NodeJS.ProcessEnv
): number[] | null {
  if (!(state.buffer > 0) || rest.length === 0) return null;
  const index = rest[0]!;
  const size = textAt(index).length;
  if (!(size > 0)) return null;
  const wall = cloneCallWallMs({
    chars: size,
    largestRow: size,
    rows: 1,
    shape: "warm",
    restore: false,
  });
  const waitCap = modalCloneWarmWaitMs(env);
  const slack = cloneRampSlackMs(state.buffer);
  const withinPublish = wall + slack - MODAL_CLONE_PUBLISH_MS <= state.buffer;
  if (!withinPublish || wall > state.buffer || wall >= waitCap || wall >= MODAL_CLONE_PROXY_KILL_MS) {
    return null;
  }
  return [index];
}

type WarmPrefix = {
  indexes: number[];
  chars: number;
  largest: number;
  wallMs: number;
};

/**
 * Warm prefixes of `rest`, shortest first, that stay inside the warm
 * character cap, the 80 MiB body, and the warm HTTP wait.
 *
 * The buffer is not a stop. A caller that must leave slack walks this
 * list and stops at the first prefix that misses it. A caller that is
 * choosing a shared-GPU turn also sees the wider prefixes, because a
 * one-row call cannot feed two listeners at 1.5×.
 */
function warmPrefixStats(
  rest: number[],
  batch: number,
  textAt: (index: number) => string,
  env: NodeJS.ProcessEnv
): WarmPrefix[] {
  const charCap = modalWarmLaneCharLimit(env);
  const waitCap = modalCloneWarmWaitMs(env);
  const out: WarmPrefix[] = [];
  let chars = 0;
  let largest = 0;
  const limit = Math.min(Math.max(1, batch), rest.length);
  for (let n = 1; n <= limit; n += 1) {
    const size = textAt(rest[n - 1]!).length;
    const nextChars = chars + size;
    const nextLargest = Math.max(largest, size);
    if (n > 1 && nextChars > charCap) break;
    if (n > 1 && estimateCloneBatchJsonBytes(nextChars) > MODAL_CLONE_RESPONSE_BODY_MAX_BYTES) {
      break;
    }
    const wallMs = cloneCallWallMs({
      chars: nextChars,
      largestRow: nextLargest,
      rows: n,
      shape: "warm",
      restore: false,
    });
    if (n > 1 && (wallMs >= waitCap || wallMs >= MODAL_CLONE_PROXY_KILL_MS)) break;
    chars = nextChars;
    largest = nextLargest;
    out.push({ indexes: rest.slice(0, n), chars, largest, wallMs });
  }
  return out;
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
  // The buffer is the only width limit. A row packed for this opening is
  // sent when it leaves the slack; a 2,000-character row that does not fit
  // is not sent. Index is not a second, tighter cap: section 0 often closes
  // a sentence past 1,000 characters, and the next row is sized from that
  // audio. Capping it again at the 1,000-character opening's row left the
  // book queued after section 0.
  let best: number[] | null = null;
  for (const pref of warmPrefixStats(rest, batch, textAt, env)) {
    if (!cloneCallFitsBuffer(pref.wallMs, state.buffer, pref.indexes.length)) break;
    best = pref.indexes;
  }
  return best;
}

function pushCall(calls: CloneWaveCall[], state: ListenerState, call: CloneWaveCall): void {
  calls.push(call);
  if (!state.started) {
    state.started = true;
    state.buffer = clonePlanningBufferMs(call.audioMs);
    return;
  }
  state.buffer = advancePlanningBuffer(state.buffer, call.wallMs, call.audioMs);
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
  const wallMs = cloneCallWallMs({
    chars,
    largestRow: largest,
    rows: input.indexes.length,
    shape: input.shape,
    restore: input.restore,
  });
  // Cold waits are the abort this wall will actually arm. Warm waits stay
  // the long budget; a warm miss is not a compile.
  const waitMs =
    input.shape === "warm"
      ? modalCloneWarmWaitMs(input.env)
      : modalCloneArmedWaitMs(false, input.firstLight, wallMs, false).ms;
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

/** One already-chosen call. Dispatch posts these indexes instead of re-planning them shorter. */
export function cloneWaveCallForIndexes(input: {
  indexes: number[];
  textAt: (index: number) => string;
  shape: CloneWaveShape;
  firstLight: boolean;
  restore: boolean;
  playbackStarted: boolean;
  bufferedMs: number;
  env?: NodeJS.ProcessEnv;
}): CloneWaveCall {
  return describeCloneWaveCall({
    indexes: input.indexes,
    shape: input.shape,
    firstLight: input.firstLight,
    restore: input.restore,
    textAt: input.textAt,
    env: input.env ?? process.env,
    state: listenerState(input.playbackStarted, input.playbackStarted ? input.bufferedMs : 0),
  });
}

export type MixedCloneRow = {
  bookId: string;
  index: number;
  key: string;
  text: string;
  referenceAudioBase64?: string;
  referenceText?: string;
  seed?: number;
};

/**
 * Rows from several books for one `synthesize_batch`.
 *
 * The deployed container cannot speak them. `synthesize_batch` takes one
 * `reference_audio_base64` for the call, and `S2Engine.render` passes that
 * one reference into every row's prompt. History is already per row, and
 * the seed is one `torch.manual_seed` for the call. A per-item reference
 * (and a per-item seed) is a container change, which means a Modal redeploy
 * and a new snapshot. `MODAL_S2_MIXED_BOOK_BATCH` stays off, and the tick
 * does not send this payload, until that container is the one answering.
 *
 * Round-robin keeps a short book from waiting behind a 24-row neighbour.
 * The cap is the same warm character cap a one-book call uses.
 */
export function planMixedCloneBatch(input: {
  books: Array<{
    id: string;
    pending: number[];
    textAt: (index: number) => string;
    referenceAudioBase64?: string;
    referenceText?: string;
    seedFor?: (index: number) => number;
  }>;
  batch: number;
  env?: NodeJS.ProcessEnv;
}): MixedCloneRow[] {
  const env = input.env ?? process.env;
  const batch = Math.max(1, Math.floor(input.batch));
  const charCap = modalWarmLaneCharLimit(env);
  const cursors = input.books.map((book) => ({ book, at: 0 }));
  const rows: MixedCloneRow[] = [];
  let chars = 0;
  let placed = true;
  while (rows.length < batch && placed) {
    placed = false;
    for (const cursor of cursors) {
      if (rows.length >= batch) break;
      const index = cursor.book.pending[cursor.at];
      if (index == null) continue;
      const text = cursor.book.textAt(index);
      const nextChars = chars + text.length;
      if (rows.length > 0 && nextChars > charCap) continue;
      if (
        rows.length > 0 &&
        estimateCloneBatchJsonBytes(nextChars) > MODAL_CLONE_RESPONSE_BODY_MAX_BYTES
      ) {
        continue;
      }
      chars = nextChars;
      cursor.at += 1;
      placed = true;
      rows.push({
        bookId: cursor.book.id,
        index,
        key: `${cursor.book.id}:${index}`,
        text,
        ...(cursor.book.referenceAudioBase64
          ? {
              referenceAudioBase64: cursor.book.referenceAudioBase64,
              referenceText: cursor.book.referenceText ?? "",
              seed: cursor.book.seedFor?.(index),
            }
          : {}),
      });
    }
  }
  return rows;
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
 * A book that has not started goes first when every listener who is
 * already playing keeps the slack through that one section. After that,
 * a call has to feed every started listener: one round of it, handed to
 * each book in turn, must not shrink their buffers. A single
 * 2,000-character row is about 64s of wall and about 84s of audio at
 * 1.5×, so two listeners alternating those rows fall behind forever.
 * When no slack-safe call can feed them, the turn is the feeding call
 * with the least silence and the highest characters per wall second —
 * a ramp or a batch, not another one-row thrash. Calls are never
 * concurrent: the caller runs this again when the call returns.
 *
 * One `synthesize_batch` still carries one reference voice. Rows from
 * two books in one call need a container that reads a reference per
 * item; that is {@link planMixedCloneBatch}, and it stays off the tick
 * until that container is deployed.
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
  // already playing keep their slack through this one section. A deep
  // buffer must not take a batch and leave the second listener waiting
  // through it. The new book does not also have to leave the others a
  // whole extra section: that reserve is what kept the second opening
  // behind the ramp and then trapped both listeners on one-row calls.
  for (const book of books) {
    if (book.playbackStarted) continue;
    let call = firstSectionCall(book, input.poolWarm, env);
    // A short piece is still one call, and about as long as its first
    // section. If the other listener cannot spare the extra transfer,
    // this book takes section 0 and ramps on a later turn.
    if (book.firstLight) {
      const whole = shortOpeningIndexes(book.pending, input.poolWarm, batch, book.textAt, env);
      if (whole && whole.length === book.pending.length) {
        const state = listenerState(false, 0);
        const batched = describeCloneWaveCall({
          indexes: whole,
          shape: input.poolWarm ? "warm" : "cold",
          firstLight: true,
          restore: !input.poolWarm,
          textAt: book.textAt,
          env,
          state,
        });
        if (unstartedCallIsSafe(book, batched, started)) call = batched;
      }
    }
    if (!unstartedCallIsSafe(book, call, started)) continue;
    return { bookId: book.id, call };
  }

  if (!input.poolWarm && started.length > 0) {
    const closest = [...started].sort((a, b) => a.bufferedMs - b.bufferedMs)[0]!;
    const cold = planModalCloneBookWave({
      pending: closest.pending,
      textAt: closest.textAt,
      firstLight: false,
      poolWarm: false,
      batch,
      bufferedMs: closest.bufferedMs,
      playbackStarted: true,
      maxCalls: 1,
      env,
    });
    const call = cold.calls[0] ?? firstSectionCall(closest, false, env);
    return { bookId: closest.id, call };
  }

  const picked = selectWarmSharedTurn(started, batch, env);
  if (picked) return { bookId: picked.book.id, call: picked.call };

  const first = books[0]!;
  return { bookId: first.id, call: firstSectionCall(first, input.poolWarm, env) };
}

/**
 * True when one round of this call, served to each started listener,
 * does not shrink the buffers.
 *
 * The audio arrives on one book. Every other listener only spends the
 * wall. `audio / 1.5` has to cover this call once per listener.
 */
function callFeedsListeners(chars: number, wallMs: number, listeners: number): boolean {
  if (!(wallMs > 0) || !(chars > 0)) return false;
  return clonePlanningBufferMs(cloneAudioMs(chars)) >= wallMs * Math.max(1, listeners);
}

/**
 * The warm call these started listeners should take.
 *
 * A slack-safe call that feeds everyone wins, and among those the
 * highest characters per wall second — the wide batch, once the buffers
 * can hold it. A one-row call feeds one listener and not two, so it is
 * not that winner. When nothing slack-safe feeds them, the feeding call
 * with the least silence is the growth step. One row is only the
 * fallback when even a wide call cannot feed them, which is a book that
 * has a single section left.
 */
function selectWarmSharedTurn(
  started: CloneListener[],
  batch: number,
  env: NodeJS.ProcessEnv
): { book: CloneListener; call: CloneWaveCall } | null {
  if (started.length === 0) return null;
  const listeners = started.length;
  type Cand = {
    book: CloneListener;
    indexes: number[];
    wallMs: number;
    chars: number;
    stall: number;
    feeds: boolean;
    slack: boolean;
  };
  const cands: Cand[] = [];
  for (const book of started) {
    for (const pref of warmPrefixStats(book.pending, batch, book.textAt, env)) {
      let stall = 0;
      for (const other of started) stall += Math.max(0, pref.wallMs - other.bufferedMs);
      const feeds = callFeedsListeners(pref.chars, pref.wallMs, listeners);
      const slack = started.every((other) =>
        other.id === book.id
          ? cloneCallFitsBuffer(pref.wallMs, book.bufferedMs, pref.indexes.length)
          : otherStillPlaying(other, pref.wallMs)
      );
      cands.push({
        book,
        indexes: pref.indexes,
        wallMs: pref.wallMs,
        chars: pref.chars,
        stall,
        feeds,
        slack,
      });
    }
  }
  const feeding = cands.filter((cand) => cand.feeds);
  const slackFed = feeding.filter((cand) => cand.slack);
  const pool = slackFed.length > 0 ? slackFed : feeding.length > 0 ? feeding : cands;
  pool.sort((a, b) => {
    if (a.stall !== b.stall) return a.stall - b.stall;
    const supplyA = a.chars / Math.max(1, a.wallMs);
    const supplyB = b.chars / Math.max(1, b.wallMs);
    if (supplyA !== supplyB) return supplyB - supplyA;
    return a.book.bufferedMs - b.book.bufferedMs;
  });
  const win = pool[0];
  if (!win) return null;
  return {
    book: win.book,
    call: describeCloneWaveCall({
      indexes: win.indexes,
      shape: "warm",
      firstLight: false,
      restore: false,
      textAt: win.book.textAt,
      env,
      state: listenerState(true, win.book.bufferedMs),
    }),
  };
}

function firstSectionCall(
  book: CloneListener,
  poolWarm: boolean,
  env: NodeJS.ProcessEnv
): CloneWaveCall {
  const state = listenerState(
    book.playbackStarted,
    book.playbackStarted ? book.bufferedMs : 0
  );
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

/** The other listener still has slack left when this call returns. */
function otherStillPlaying(other: CloneListener, wallMs: number): boolean {
  if (!other.playbackStarted) return true;
  const slack = cloneRampSlackMs(other.bufferedMs);
  return other.bufferedMs - wallMs >= slack;
}

function unstartedCallIsSafe(
  book: CloneListener,
  call: CloneWaveCall,
  started: CloneListener[]
): boolean {
  const opening = clonePlanningBufferMs(call.audioMs);
  const next = nextSectionWall(book, call.indexes.length, true);
  if (next > 0 && opening < next + cloneRampSlackMs(opening)) return false;
  return started.every((other) => otherStillPlaying(other, call.wallMs));
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
  const state = listenerState(
    book.playbackStarted === true,
    book.playbackStarted === true ? Math.max(0, book.bufferedMs ?? 0) : 0
  );
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
  /** Smallest (1× audio still unplayed − call wall) once playback has started. */
  minMarginAt1xMs: number;
  /**
   * Smallest (wall time left at 1.5× − call wall) once playback has started.
   * Wall time left is delivered / 1.5 − elapsed. This is the margin the ramp
   * plans against.
   */
  minMarginAt15xMs: number;
};

/**
 * Play one book at 1.5× from the moment its first audio returns.
 *
 * The planning buffer is wall time left (`delivered / 1.5 − elapsed`).
 * Each call subtracts its wall directly. The 1× margin is the same clock
 * with audio consumed one second per wall second, reported beside it.
 * A stall is a call that starts while the listener is already playing and
 * runs longer than the audio they have left at 1.5×.
 */
export function simulateClonePlayback(input: {
  sectionChars: number[];
  batch?: number;
  claim?: number;
  /** The container is already up, so the opening call pays no restore. */
  poolWarm?: boolean;
  /**
   * One call takes this many times its planned wall. The next call is
   * planned from the buffer that spend actually left.
   */
  slowCall?: { step: number; factor: number };
  env?: NodeJS.ProcessEnv;
}): ClonePlaybackReport {
  const env = input.env ?? process.env;
  const batch = input.batch ?? 24;
  const claim = input.claim ?? batch;
  const charsAt = input.sectionChars;
  let pending = charsAt.map((_, index) => index);
  let poolWarm = input.poolWarm === true;
  let started = false;
  /** Wall time left at 1.5×. This is the buffer the planner sees. */
  let wallLeft = 0;
  /** Audio still unplayed for a listener at 1×. Reported, not planned. */
  let audio1x = 0;
  let clock = 0;
  let timeToFirstAudioMs = 0;
  const steps: ClonePlaybackStep[] = [];
  const margins1x: number[] = [];
  const margins15: number[] = [];
  let guard = 0;
  while (pending.length > 0 && guard < charsAt.length + 5) {
    guard += 1;
    const window = pending.slice(0, claim);
    let windowLeft = window;
    let windowGuard = 0;
    while (windowLeft.length > 0 && windowGuard < window.length + 2) {
      windowGuard += 1;
      const plan = planModalCloneBookWave({
        pending: windowLeft,
        textAt: (index) => "x".repeat(charsAt[index] ?? 0),
        firstLight: windowLeft[0] === 0 && !started,
        poolWarm,
        batch,
        bufferedMs: started ? wallLeft : 0,
        playbackStarted: started,
        entireRemainder: windowLeft.length === pending.length,
        maxCalls: 1,
        env,
      });
      const call = plan.calls[0];
      if (!call) break;
      const spent =
        input.slowCall && steps.length === input.slowCall.step
          ? Math.round(call.wallMs * input.slowCall.factor)
          : call.wallMs;
      if (started) {
        margins1x.push(audio1x - call.wallMs);
        margins15.push(wallLeft - call.wallMs);
      }
      steps.push({
        bookId: "book",
        rows: call.indexes.length,
        chars: call.chars,
        shape: call.shape,
        wallMs: spent,
        audioMs: call.audioMs,
        bufferAtDispatchMs: started ? wallLeft : 0,
        fitsBuffer: call.fitsBuffer,
      });
      clock += spent;
      if (timeToFirstAudioMs === 0) timeToFirstAudioMs = clock;
      if (!started) {
        started = true;
        wallLeft = clonePlanningBufferMs(call.audioMs);
        audio1x = call.audioMs;
      } else {
        wallLeft = advancePlanningBuffer(wallLeft, spent, call.audioMs);
        audio1x = Math.max(0, audio1x - spent) + call.audioMs;
      }
      poolWarm = true;
      const taken = new Set(call.indexes);
      windowLeft = windowLeft.filter((index) => !taken.has(index));
      pending = pending.filter((index) => !taken.has(index));
    }
    if (windowGuard === 0 || steps.length === 0) break;
    if (windowLeft.length === window.length) break;
  }
  return {
    steps,
    timeToFirstAudioMs,
    totalWallMs: clock,
    stallCount: steps.filter((step) => !step.fitsBuffer).length,
    sizeSequence: steps.map((step) => step.rows),
    minMarginMs: margins1x.length > 0 ? Math.min(...margins1x) : 0,
    minMarginAt1xMs: margins1x.length > 0 ? Math.min(...margins1x) : 0,
    minMarginAt15xMs: margins15.length > 0 ? Math.min(...margins15) : 0,
  };
}

/**
 * Several books, one GPU, each listened to at 1.5× from its own first audio.
 * Calls never overlap. {@link chooseCloneGpuTurn} picks the one call.
 * A book with `startAtMs` is not in the queue until the clock reaches it,
 * and it does not drain before its own first audio.
 */
export function simulateCloneListeners(input: {
  books: Array<{ id: string; sectionChars: number[]; startAtMs?: number }>;
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
    startAt: Math.max(0, book.startAtMs ?? 0),
    /** Wall time left at 1.5×. */
    wall: 0,
    /** Audio still unplayed at 1×. */
    audio1x: 0,
    clockAtStart: 0,
    steps: [] as ClonePlaybackStep[],
    minMarginMs: Number.POSITIVE_INFINITY,
    minMargin15: Number.POSITIVE_INFINITY,
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
        .filter((book) => book.next < book.chars.length && clock >= book.startAt)
        .map((book) => ({
          id: book.id,
          pending: book.chars.slice(book.next).map((_, offset) => book.next + offset),
          textAt: (index) => "x".repeat(book.chars[index] ?? 0),
          playbackStarted: book.started,
          bufferedMs: book.started ? book.wall : 0,
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
      const left1x = other.audio1x - turn.call.wallMs;
      const left15 = other.wall - turn.call.wallMs;
      other.minMarginMs = Math.min(other.minMarginMs, left1x);
      other.minMargin15 = Math.min(other.minMargin15, left15);
      if (left15 < 0) other.drained += 1;
      other.wall = Math.max(0, left15);
      other.audio1x = Math.max(0, left1x);
    }
    clock += turn.call.wallMs;
    if (!book.started) book.clockAtStart = clock;
    if (book.started) {
      book.minMarginMs = Math.min(book.minMarginMs, book.audio1x - turn.call.wallMs);
      book.minMargin15 = Math.min(book.minMargin15, book.wall - turn.call.wallMs);
      book.wall = advancePlanningBuffer(book.wall, turn.call.wallMs, turn.call.audioMs);
      book.audio1x = Math.max(0, book.audio1x - turn.call.wallMs) + turn.call.audioMs;
    } else {
      book.started = true;
      book.wall = clonePlanningBufferMs(turn.call.audioMs);
      book.audio1x = turn.call.audioMs;
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
      minMarginAt1xMs: Number.isFinite(book.minMarginMs) ? book.minMarginMs : 0,
      minMarginAt15xMs: Number.isFinite(book.minMargin15) ? book.minMargin15 : 0,
    })),
    totalWallMs: clock,
    // The loop runs one call to the clock before choosing the next, so two
    // books never have a call in flight together.
    overlapping: false,
  };
}
