/**
 * Lane dispatch for the self-hosted S2-Pro clone path.
 *
 * The book is asynchronous: the browser is not holding a request open, so
 * "the GPU pool has not restored yet" is a reason to come back later, not a
 * reason to switch narrator. This module owns that decision so the tick loop
 * only has to act on the answer.
 *
 * Three rules, all learned the hard way:
 *   - A book may wait for a snapshot restore. It must not wait for a compile.
 *     One placement that misses the restore budget is dropped; the unstaged
 *     sections are tried once on another container. Only when nothing comes
 *     back does the book park, and the compile itself is an off-path RPC.
 *   - A book never changes engine mid-way. The pin is decided once and stored,
 *     and the only way it changes is the defer budget running out — which also
 *     writes a warning the person can see.
 *   - Nothing is playable until section 0 is, so section 0 is rendered alone,
 *     before any other lane opens (see {@link LaneDispatchOptions.firstLight}).
 *
 * ## Why first light exists
 *
 * Four lanes opened at once on an empty pool is one restore and then four GPU
 * jobs queued behind it on the same container: measured 2026-11-06 on
 * `job db10a6d6`, lane calls for sections 1 and 3 returned at +90s and +126s
 * while section 0 — the only section the player can start with — landed at
 * +141s, and one lane missed the restore budget and had to be retried. The
 * book paid a full fan-out of wall clock before a single second of audio was
 * playable. Rendering section 0 on its own first makes time-to-first-audio
 * one restore plus one section, and only then does the book fan out.
 */

import {
  ModalCloneColdError,
  ModalCloneLaneBusyError,
  ModalCloneProviderError,
  modalClonePoolIsWarm,
  noteModalClonePoolLost,
  rememberModalCloneCold,
  type CloneBatchItem,
  type CloneBatchOutcome,
} from "@/lib/tts/providers/modal-clone";
import { ModalWorkspaceDisabledError } from "@/lib/modal/workspace-disabled";
import { kickModalCloneSnapshotWarm } from "@/lib/tts/providers/modal-clone-warm";
import {
  MODAL_CLONE_PUBLISH_MS,
  cloneAudioMs,
  cloneCallWallMs,
  clonePlanningBufferMs,
  modalCloneArmedWaitMs,
  planModalCloneBookWave,
  planModalCloneLanes,
  pageLane,
} from "@/lib/tts/providers/modal-clone-lanes";
import { modalCloneLanes } from "@/lib/tts/providers/modal-clone-guard";
import { holdModalCloneLaneSlot } from "@/lib/tts/provider-slots";

export interface LaneDispatchOptions {
  /** Claimable indexes, ascending. */
  indexes: number[];
  textAt: (index: number) => string;
  /** Concurrent container calls for this book. */
  lanes: number;
  /** Rows per call. */
  batch: number;
  /** Characters one lane may hold. */
  maxLaneChars: number;
  /** Retry generation; moves the render seed. */
  seedEpoch: number;
  /**
   * One HTTP batch call. Rejects with ModalCloneColdError on a cold pool.
   *
   * `raceForFirstAudio` is true only for the first-light call. That call may
   * give up on a restore earlier than a normal placement, because its wait is
   * wall clock in front of the person and the compile is finished off-path
   * either way (#237).
   */
  render: (
    items: CloneBatchItem[],
    seedEpoch: number,
    opts?: { raceForFirstAudio?: boolean; workMs?: number; warmBatch?: boolean }
  ) => Promise<CloneBatchOutcome>;
  /** Persist a rendered section (section cache + any bookkeeping). */
  stage: (index: number, audio: Buffer, durationSeconds: number) => Promise<void>;
  /**
   * Publish the first-light section through the normal section path — master
   * it, upload it, write `segments_json` — so the player can start.
   *
   * Called as soon as that section is staged and not awaited until the dispatch
   * ends, so mastering and uploading it overlap the rest of the fan-out instead
   * of holding three lanes idle on ffmpeg. It is expected to find the take in
   * the section cache that `stage` just wrote, so publishing costs no second
   * GPU call. Awaiting it before returning keeps the caller's bookkeeping
   * simple: when a dispatch returns, the first section is published or its
   * failure is known.
   */
  publishFirstLight?: (index: number) => Promise<void>;
  /**
   * Publish a call's sections as soon as they are staged. The next GPU call
   * starts without waiting for ffmpeg. Section 0 is included, so the player
   * can start while the ramp's next call is already in flight.
   * `publishFirstLight` is the one-section form used when this is omitted.
   */
  publishStaged?: (indexes: number[]) => Promise<void>;
  /**
   * Section 0 is still missing, so the player has nothing to start with.
   *
   * When set, the lowest index is rendered alone on one lane first, and only
   * then does the rest of the fan-out open. Nothing is playable until that
   * section is, and four lanes opened at once on a scaled-to-zero pool made the
   * person wait for the whole wave (and pay several cold restores) before a
   * single second of audio (`job db10a6d6`, 2026-11-06: ~4m38s to ready on a
   * 5-section book, section 0 at +141s).
   *
   * The fan-out is skipped when that section does not come back: a pool that
   * could not restore it will not restore three more calls either.
   */
  firstLight?: boolean;
  /**
   * One restored H100. The first call stays one section, unless `indexes`
   * is the whole remaining book and one call is no slower to first audio
   * than that section. Each later call is only as wide as the audio already
   * buffered ahead of the listener, and the next call starts when the
   * previous one returns. Later ticks stay on that ramp while
   * {@link modalClonePoolIsWarm} is true, and drop back to one cold-sized
   * call when the container has scaled away. Calls run one at a time. Omit
   * this and the older multi-lane planner runs.
   */
  bookWave?: boolean;
  /**
   * `indexes` is every section this book still has to speak. A claim that
   * stopped at the batch size is not the whole book.
   */
  entireRemainder?: boolean;
  /**
   * Audio already delivered and not yet played. The ramp sizes the next
   * call against this. Omit it and a warm tick does not assume a deep buffer.
   */
  bufferedMs?: number;
  /** The listener has already heard audio from this book. */
  playbackStarted?: boolean;
  /** Stop the ramp after this many calls so another book can take the GPU. */
  maxCalls?: number;
  /**
   * Called before every call after the first. When it returns true the
   * ramp stops so a take-home that became runnable during this tick can
   * have the GPU. A tick that started alone still re-checks.
   */
  yieldToOther?: () => Promise<boolean>;
  /**
   * Overrides the in-process warmth bit. Tests pin it; the tick leaves it
   * unset and the dispatch reads {@link modalClonePoolIsWarm}.
   */
  poolWarm?: boolean;
  log?: (message: string) => void;
}

/** What the first-light section cost, for the tick log. */
export interface FirstLightReport {
  index: number;
  /** Rendered and published, so the player can start with it. */
  staged: boolean;
  /** Wall time from the first HTTP call to the section being staged. */
  elapsedMs: number;
  /** Rendered, but the master/upload that makes it playable failed. */
  publishError?: boolean;
}

export interface LaneDispatchResult {
  /** Indexes rendered and staged by this dispatch. */
  staged: number;
  /** Indexes that were planned but produced no audio this time. */
  missing: number[];
  /** True when the pool had nothing warm and the book should be parked. */
  cold: boolean;
  /**
   * Calls that had more work than their budget while the pool was warm.
   * Retried once with one section per call; never a reason to park or to kick
   * a snapshot compile.
   */
  oversize: number[];
  /** Lanes that found their container already rendering. Retryable, not cold. */
  busy: number;
  /** The ramp stopped because another take-home became runnable. */
  handedOff?: boolean;
  /**
   * Modal answered with a hard error (a 5xx that is not a cold placement).
   * The tick parks on the provider-fault clock instead of failing the book.
   */
  providerFault: string | null;
  /** Containers that answered, and the builds they reported. */
  containers: string[];
  builds: string[];
  /** Sum of the server's measured generation seconds, for the tick log. */
  generateSeconds: number;
  /** What the containers said about their boot: `restored` or `unknown`. */
  boot: string[];
  /** Null unless {@link LaneDispatchOptions.firstLight} ran. */
  firstLight: FirstLightReport | null;
}

interface WaveOutcome {
  attempted: number[];
  staged: Set<number>;
  /** Indexes whose container missed the restore budget. */
  placement: number[];
  /**
   * Indexes whose call had too much work for its budget while the pool was
   * demonstrably warm. Not cold: splitting the call is the fix.
   */
  oversize: number[];
  /**
   * Placement misses whose wait was a restore. A warm wait is not in
   * this list, and neither is a one-row retry that follows a warm miss.
   */
  compile: number[];
  poolCold: boolean;
  poolReason: string;
  busy: number;
  providerFault: string | null;
  containers: string[];
  builds: string[];
  boot: string[];
  generateSeconds: number;
}

/** Everything one dispatch accumulates across its waves. */
interface DispatchTally {
  attempted: number[];
  staged: Set<number>;
  placement: number[];
  oversize: number[];
  compile: number[];
  poolCold: boolean;
  poolReason: string;
  busy: number;
  providerFault: string | null;
  containers: string[];
  builds: string[];
  boot: string[];
  generateSeconds: number;
}

function emptyTally(): DispatchTally {
  return {
    attempted: [],
    staged: new Set(),
    placement: [],
    oversize: [],
    compile: [],
    poolCold: false,
    poolReason: "",
    busy: 0,
    providerFault: null,
    containers: [],
    builds: [],
    boot: [],
    generateSeconds: 0,
  };
}

function mergeWave(tally: DispatchTally, wave: WaveOutcome): void {
  for (const index of wave.attempted) {
    if (!tally.attempted.includes(index)) tally.attempted.push(index);
  }
  for (const index of wave.staged) tally.staged.add(index);
  tally.placement = [
    ...new Set([...tally.placement, ...wave.placement.filter((i) => !tally.staged.has(i))]),
  ];
  tally.oversize = [
    ...new Set([...tally.oversize, ...wave.oversize.filter((i) => !tally.staged.has(i))]),
  ];
  tally.compile = [
    ...new Set([...tally.compile, ...wave.compile.filter((i) => !tally.staged.has(i))]),
  ];
  tally.busy += wave.busy;
  tally.containers.push(...wave.containers);
  tally.builds.push(...wave.builds);
  tally.boot.push(...wave.boot);
  tally.generateSeconds += wave.generateSeconds;
  if (wave.poolCold) {
    tally.poolCold = true;
    tally.poolReason = wave.poolReason;
  }
  if (wave.providerFault && !tally.providerFault) {
    tally.providerFault = wave.providerFault;
  }
}

/**
 * Render every planned lane and stage what comes back.
 *
 * With {@link LaneDispatchOptions.firstLight} the lowest index goes first on a
 * single lane; the remaining lanes only open once it is staged. Lanes then run
 * at once, so one compiling variant does not hold the others. A placement that
 * misses the restore budget is tried once more on another container. A probe
 * that says the pool is empty is not retried: more HTTP calls would each wait
 * the same budget and still could not finish a compile.
 */
export async function dispatchModalCloneLanes(
  opts: LaneDispatchOptions
): Promise<LaneDispatchResult> {
  if (opts.bookWave) return dispatchBookWave(opts);
  const log = opts.log ?? (() => {});
  const tally = emptyTally();
  let remaining = opts.indexes;
  let firstLight: FirstLightReport | null = null;
  /** Started when the first-light section lands, settled before we return. */
  let publishing: Promise<void> | null = null;
  const publishState: { error: unknown } = { error: null };
  // The rest of the fan-out waits for the section the player needs. A pool
  // that could not restore it gains nothing from three more cold waits.
  let mayFanOut = true;

  if (opts.firstLight && remaining.length > 0) {
    const head = remaining[0]!;
    remaining = remaining.slice(1);
    const startedAt = Date.now();
    mergeWave(tally, await runWave(opts, [head], log, 1, true));
    if (!tally.poolCold && tally.placement.includes(head)) {
      // One retry on another container, exactly as a batched lane gets. Two
      // restore budgets is still not a compile.
      log(`[S2 lanes] first-light section ${head} missed the restore budget; retrying it`);
      mergeWave(tally, await runWave(opts, [head], log, 1, true));
    }
    const headStaged = tally.staged.has(head);
    firstLight = { index: head, staged: headStaged, elapsedMs: Date.now() - startedAt };
    log(
      `[S2 lanes] first light section ${head} ` +
        `${headStaged ? `staged in ${Math.round(firstLight.elapsedMs / 1000)}s` : "not staged"}`
    );
    if (!headStaged && tally.placement.includes(head)) {
      // The head spent both restore budgets. Fanning the other lanes out now
      // would be the same wait again on a pool that clearly is not restoring.
      tally.poolCold = true;
      tally.poolReason = `section ${head} missed the restore budget`;
    }
    // A hard fault or a busy lane is not cold: the fan-out is skipped but the
    // book is not parked, so the per-section path can surface the real reason.
    mayFanOut = headStaged;
    if (headStaged && opts.publishFirstLight) {
      // Start it now, settle it at the end. Mastering a section is a couple of
      // CPU-bound ffmpeg passes; running it inside the critical path here would
      // idle every other lane for as long as it takes.
      publishing = opts.publishFirstLight(head).catch((err: unknown) => {
        publishState.error = err;
      });
    }
  }

  if (mayFanOut && !tally.poolCold && remaining.length > 0) {
    const wave = await runWave(opts, remaining, log, opts.lanes);
    mergeWave(tally, wave);
    // A multi-section call that missed its budget is retried **one section per
    // call**. Resending the same pack is what made `job 7e4a8b48` loop: 31k
    // characters in one call, aborted at 150s, resent as the same 31k on
    // another container, aborted again. A one-row call runs at the slow rate,
    // but it is a rate that completes.
    if (!wave.poolCold && wave.oversize.length > 0) {
      const split = wave.oversize.filter((index) => !tally.staged.has(index));
      if (split.length > 0) {
        log(
          `[S2 lanes] multi-section call missed its budget; retrying [${split.join(",")}] one section per call`
        );
        mergeWave(
          tally,
          await runWave(opts, split, log, Math.min(opts.lanes, split.length), false, 1)
        );
      }
    }
    // A single-section call that never came back is one placement that missed,
    // and one retry on another container is the budget #237 allows.
    if (!wave.poolCold && wave.placement.length > 0) {
      const retry = wave.placement.filter((index) => !tally.staged.has(index));
      if (retry.length > 0) {
        log(`[S2 lanes] placement missed restore budget; retrying [${retry.join(",")}]`);
        mergeWave(tally, await runWave(opts, retry, log, opts.lanes));
      }
    }
  }
  return finishDispatch(tally, firstLight, publishing, publishState, log);
}

/**
 * One book, one H100. Section 0 (or the first cold call after a scaledown)
 * stays one section, unless the indexes are the whole remaining book and
 * one call adds no generation beyond that section. Each later call is only
 * as wide as the audio already buffered for the listener, and the next
 * call starts as soon as the previous one returns. A warm call that misses
 * its budget is retried as one section and the rest waits for the next
 * tick, so this book does not open a second GPU.
 */
async function dispatchBookWave(opts: LaneDispatchOptions): Promise<LaneDispatchResult> {
  const log = opts.log ?? (() => {});
  const tally = emptyTally();
  let firstLight: FirstLightReport | null = null;
  const publishState: { error: unknown } = { error: null };
  let publishChain: Promise<void> = Promise.resolve();
  let poolWarm = opts.poolWarm ?? modalClonePoolIsWarm();
  let pending = [...opts.indexes].sort((a, b) => a - b);
  let started = opts.playbackStarted === true;
  // `bufferedMs` is already the planning buffer (1× spare / 1.5). The 1×
  // spare is what the clock between calls consumes.
  let buffer = started ? Math.max(0, opts.bufferedMs ?? 0) : 0;
  let spare1x = started ? Math.round(buffer * 1.5) : 0;
  const callLimit =
    typeof opts.maxCalls === "number" && opts.maxCalls > 0
      ? Math.floor(opts.maxCalls)
      : Number.POSITIVE_INFINITY;
  let made = 0;
  let handedOff = false;

  const enqueuePublish = (indexes: number[], head: boolean) => {
    if (indexes.length === 0) return;
    const task = () => {
      const run = opts.publishStaged
        ? opts.publishStaged(indexes)
        : head && opts.publishFirstLight && indexes[0] != null
          ? opts.publishFirstLight(indexes[0])
          : null;
      if (!run) return Promise.resolve();
      return run.catch((err: unknown) => {
        if (head) publishState.error = err;
        else {
          log(
            `[S2 lanes] sections [${indexes.join(",")}] did not publish: ` +
              `${err instanceof Error ? err.message : String(err)}`
          );
        }
      });
    };
    publishChain = publishChain.then(task, task);
  };

  while (pending.length > 0 && made < callLimit && !tally.poolCold && tally.busy === 0) {
    if (made > 0 && opts.yieldToOther) {
      const yieldNow = await opts.yieldToOther();
      if (yieldNow) {
        handedOff = true;
        log("[S2 lanes] another take-home is runnable; stopping the ramp");
        break;
      }
    }
    const plan = planModalCloneBookWave({
      pending,
      textAt: opts.textAt,
      firstLight: opts.firstLight === true && !started,
      poolWarm,
      batch: opts.batch,
      bufferedMs: buffer,
      playbackStarted: started,
      entireRemainder:
        opts.entireRemainder === true && pending.length === opts.indexes.length,
      maxCalls: 1,
    });
    const call = plan.calls[0];
    if (!call) break;
    log(
      `[S2 lanes] book wave pool=${poolWarm ? "warm" : "cold"} ` +
        `buffer=${Math.round(buffer)} ${call.shape}:${call.indexes.length}`
    );
    const isHead = opts.firstLight === true && !started && call.shape === "cold";
    const startedAt = Date.now();
    const wave = await runWave(opts, call.indexes, log, 1, isHead, undefined, {
      maxLaneChars: Number.POSITIVE_INFINITY,
      warmBatch: call.shape === "warm",
    });
    mergeWave(tally, wave);
    if (tally.busy > 0 || tally.providerFault) break;

    if (isHead && !tally.poolCold && tally.placement.includes(call.indexes[0]!)) {
      log(
        `[S2 lanes] first-light section ${call.indexes[0]} missed the restore budget; retrying it`
      );
      mergeWave(
        tally,
        await runWave(opts, call.indexes, log, 1, true, undefined, {
          maxLaneChars: Number.POSITIVE_INFINITY,
          warmBatch: false,
        })
      );
    }

    if (isHead) {
      const head = call.indexes[0]!;
      const headStaged = tally.staged.has(head);
      firstLight = {
        index: head,
        staged: headStaged,
        elapsedMs: Date.now() - startedAt,
      };
      log(
        `[S2 lanes] first light section ${head} ` +
          `${headStaged ? `staged in ${Math.round(firstLight.elapsedMs / 1000)}s` : "not staged"}`
      );
      if (!headStaged && tally.placement.includes(head)) {
        tally.poolCold = true;
        tally.poolReason = `section ${head} missed the restore budget`;
      }
      if (!headStaged || tally.poolCold) break;
    }

    if (!isHead && wave.poolCold) break;

    if (!isHead && !wave.poolCold && wave.oversize.length > 0) {
      const split = wave.oversize.filter((index) => !tally.staged.has(index));
      if (split.length > 0) {
        const one = split.slice(0, 1);
        log(
          `[S2 lanes] ${call.shape} batch missed its budget; retrying [${one.join(",")}] and leaving the rest`
        );
        mergeWave(
          tally,
          // warmBatch is false because the wide call missed. compileKick is
          // false so this retry cannot start a snapshot compile.
          await runWave(opts, one, log, 1, false, 1, {
            maxLaneChars: Number.POSITIVE_INFINITY,
            warmBatch: false,
            compileKick: call.shape === "warm" ? false : undefined,
          })
        );
      }
      enqueuePublish(
        call.indexes.filter((index) => tally.staged.has(index)),
        false
      );
      break;
    }

    if (!isHead && call.shape === "cold" && !wave.poolCold && wave.placement.length > 0) {
      const retry = wave.placement.filter((index) => !tally.staged.has(index));
      if (retry.length > 0) {
        log(`[S2 lanes] placement missed restore budget; retrying [${retry.join(",")}]`);
        mergeWave(
          tally,
          await runWave(opts, retry, log, 1, false, undefined, {
            maxLaneChars: Number.POSITIVE_INFINITY,
            warmBatch: false,
          })
        );
      }
    }

    const stagedRows = call.indexes.filter((index) => tally.staged.has(index));
    if (isHead) {
      enqueuePublish(stagedRows, true);
    } else {
      enqueuePublish(stagedRows, false);
    }
    // A row the container rejected is not sent again in this tick. The
    // ledger retries it next time. The rows after it are still owed an
    // attempt, or a book that fails one section stays queued with the
    // rest never spoken.
    if (stagedRows.length !== call.indexes.length) {
      const dropped = new Set(
        call.indexes.filter((index) => !tally.staged.has(index))
      );
      pending = pending.filter((index) => !dropped.has(index));
    }
    if (tally.busy > 0 || pending.length === 0) break;
    if (stagedRows.length === 0) {
      // The container answered and every row failed. The listener gained
      // no audio, so the next section is sent on its own instead of
      // waiting out a buffer that will not grow.
      buffer = 0;
      poolWarm = true;
      made += 1;
      continue;
    }

    const elapsed = Date.now() - startedAt;
    const spent = Math.max(elapsed + MODAL_CLONE_PUBLISH_MS, call.wallMs);
    const stagedChars = stagedRows.reduce(
      (sum, index) => sum + opts.textAt(index).length,
      0
    );
    const audio = cloneAudioMs(stagedChars);
    if (!started) {
      started = true;
      spare1x = audio;
    } else {
      spare1x = Math.max(0, spare1x - spent) + audio;
    }
    buffer = clonePlanningBufferMs(spare1x);
    const taken = new Set(stagedRows);
    pending = pending.filter((index) => !taken.has(index));
    poolWarm = true;
    made += 1;
  }

  const result = await finishDispatch(tally, firstLight, publishChain, publishState, log);
  return handedOff ? { ...result, handedOff: true } : result;
}

async function finishDispatch(
  tally: DispatchTally,
  firstLight: FirstLightReport | null,
  publishing: Promise<void> | null,
  publishState: { error: unknown },
  log: (message: string) => void
): Promise<LaneDispatchResult> {
  if (tally.compile.length > 0) {
    // Only a restore-budget miss kicks the compile RPC. A warm wait that
    // expired is a slow container, and the one-row retry after a warm miss
    // is sent with compile suppressed so it cannot start a compile either.
    kickModalCloneSnapshotWarm("placement exceeded restore budget");
  }

  if (publishing) {
    await publishing;
    const publishError = publishState.error;
    if (publishError) {
      log(
        `[S2 lanes] first-light section ${firstLight!.index} did not publish: ` +
          `${publishError instanceof Error ? publishError.message : String(publishError)}`
      );
      if (firstLight) {
        firstLight = { ...firstLight, staged: false, publishError: true };
      }
      tally.staged.delete(firstLight!.index);
    }
  }

  const cold = tally.poolCold || (tally.placement.length > 0 && tally.staged.size === 0);
  if (!tally.poolCold && tally.placement.length > 0) {
    rememberModalCloneCold();
  }
  if (cold) log(`[S2 lanes] cold pool: ${tally.poolReason || "placement missed restore budget"}`);

  return {
    staged: tally.staged.size,
    missing: tally.attempted.filter((index) => !tally.staged.has(index)),
    cold,
    oversize: [...tally.oversize],
    busy: tally.busy,
    providerFault: tally.providerFault,
    containers: [...new Set(tally.containers)],
    builds: [...new Set(tally.builds)],
    boot: [...new Set(tally.boot)],
    generateSeconds: Math.round(tally.generateSeconds * 10) / 10,
    firstLight,
  };
}

async function runWave(
  opts: LaneDispatchOptions,
  indexes: number[],
  log: (message: string) => void,
  lanes: number,
  raceForFirstAudio = false,
  /**
   * Rows per call for this wave specifically. A retry of a lane that ran out
   * of budget passes 1: the pack did not fit, so the same pack on another
   * container cannot fit either, while single sections can.
   */
  rowsPerCall?: number,
  wave?: { maxLaneChars?: number; warmBatch?: boolean; compileKick?: boolean }
): Promise<WaveOutcome> {
  const rowsPerPage = Math.max(1, Math.floor(rowsPerCall ?? opts.batch));
  const plan = planModalCloneLanes({
    pending: indexes,
    textAt: opts.textAt,
    limits: {
      lanes,
      batch: Math.min(opts.batch, rowsPerPage),
      maxLaneChars: wave?.maxLaneChars ?? opts.maxLaneChars,
    },
  });
  const attempted = plan.lanes.flat();
  const staged = new Set<number>();
  const containers: string[] = [];
  const builds: string[] = [];
  const boot: string[] = [];
  let generateSeconds = 0;
  let poolCold = false;
  let poolReason = "";
  let busy = 0;
  let providerFault: string | null = null;
  const placement: number[] = [];
  const oversize: number[] = [];
  const compile: number[] = [];

  if (attempted.length === 0) {
    return {
      attempted,
      staged,
      placement,
      oversize,
      compile,
      poolCold,
      poolReason,
      busy,
      providerFault,
      containers,
      builds,
      boot,
      generateSeconds,
    };
  }

  const laneResults = await Promise.all(
    plan.lanes.map(async (lane) => {
      const stagedHere: number[] = [];
      // One shared permit per HTTP lane. A second worker blocks here instead
      // of opening another container call. No wait: sitting out the restore
      // budget would look like a cold compile.
      // A book wave holds one lane. modalCloneLanes() defaults to 4, and a
      // miss that then fans out per section would start that many H100s.
      const slot = await holdModalCloneLaneSlot(opts.bookWave ? 1 : modalCloneLanes());
      if (!slot) {
        return {
          lane,
          error: new ModalCloneLaneBusyError("shared clone lane is in use"),
        };
      }
      try {
        for (const page of pageLane(lane, rowsPerPage)) {
          // A race is only meaningful for the call that carries section 0.
          const races = raceForFirstAudio && page.includes(0);
          // Give this exact pack the time it is planned to need. A call's wall
          // time is set by its longest row, so this uses both rates: the
          // aggregate for the page and the single-row rate for its biggest
          // section. Without it the packer could schedule a lane it believes
          // fits while a shorter HTTP wait cut it off — the mismatch behind
          // `job 7e4a8b48`.
          const pageChars = page.reduce(
            (sum, index) => sum + opts.textAt(index).length,
            0
          );
          const largestRow = page.reduce(
            (max, index) => Math.max(max, opts.textAt(index).length),
            0
          );
          const warm = wave?.warmBatch === true;
          const wallMs = cloneCallWallMs({
            chars: pageChars,
            largestRow,
            rows: page.length,
            shape: warm ? "warm" : "cold",
            restore: !warm,
          });
          if (!warm) {
            const abortMs = modalCloneArmedWaitMs(false, races, wallMs, false).ms;
            if (!(wallMs < abortMs)) {
              log(
                `[S2 lanes] cold pack of ${page.length} rows / ${pageChars} chars ` +
                  `does not fit its abort (${wallMs}ms >= ${abortMs}ms)`
              );
              oversize.push(...page);
              break;
            }
          }
          const outcome = await opts.render(
            page.map((index) => ({ key: String(index), text: opts.textAt(index) })),
            opts.seedEpoch,
            {
              raceForFirstAudio: races,
              // The abort is armed from this same wall, not from the old
              // 100/50 character clocks.
              workMs: wallMs,
              warmBatch: warm,
            }
          );
          if (outcome.containerId) containers.push(outcome.containerId);
          if (outcome.build) builds.push(outcome.build);
          if (outcome.boot) boot.push(outcome.boot);
          const perf = outcome.performance as
            | { generate_s?: number }
            | null
            | undefined;
          if (perf && typeof perf.generate_s === "number") {
            generateSeconds += perf.generate_s;
          }
          let rendered = 0;
          for (const [key, hit] of outcome.audio) {
            const index = Number(key);
            if (!Number.isInteger(index)) continue;
            await opts.stage(index, hit.audio, hit.durationSeconds);
            staged.add(index);
            stagedHere.push(index);
            rendered += 1;
          }
          // A page that produced nothing for a section leaves it unclaimed, so
          // the per-section path retries it. That is the intended fall-through.
          log(
            `[S2 lanes] ${wave?.warmBatch ? "warm" : "cold"} page of ${page.length} rendered ${rendered}/${page.length}`
          );
          if (rendered < page.length) break;
        }
        return { lane, error: null as unknown };
      } catch (error) {
        if (error instanceof ModalWorkspaceDisabledError) throw error;
        // A 429 means the lane is busy, not that the pool went cold.
        // Dropping warmth here is what made the next tick open another GPU.
        if (wave?.warmBatch && !(error instanceof ModalCloneLaneBusyError)) {
          noteModalClonePoolLost();
        }
        return { lane, error };
      } finally {
        await slot.release();
      }
    })
  );

  for (const result of laneResults) {
    const err = result.error;
    if (!err) continue;
    if (err instanceof ModalCloneColdError && err.scope === "placement") {
      const missed = result.lane.filter((index) => !staged.has(index));
      if (missed.length === 0) continue;
      // A **multi-section** call that misses its budget is a pack that did not
      // fit, not a container that did not restore: the wait it was given was
      // sized from its own characters at a measured rate, so missing it means
      // the rate was optimistic. Splitting is the only retry worth making —
      // resending the same pack on another container is what made
      // `job 7e4a8b48` loop. This holds whether or not a sibling answered.
      if (result.lane.length > 1) oversize.push(...missed);
      else {
        placement.push(...missed);
        if (err.waitKind !== "warm" && wave?.compileKick !== false) {
          compile.push(...missed);
        }
      }
    } else if (err instanceof ModalCloneColdError) {
      poolCold = true;
      poolReason = err.message;
    } else if (err instanceof ModalCloneLaneBusyError) {
      // Another lane is rendering in that container. This is neither cold nor
      // fatal: the sections stay unclaimed so a later tick picks them up.
      busy += 1;
      log(`[S2 lanes] lane busy: ${err.message}`);
    } else if (err instanceof ModalCloneProviderError) {
      // A 5xx is the container answering, not a cold restore. The book parks
      // on the provider-fault clock (`job 5f09ee0e`) instead of fanning out
      // more calls or failing the section as a spent retry.
      providerFault = err.message;
      log(`[S2 lanes] provider fault: ${err.message}`);
    } else {
      log(`[S2 lanes] lane failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    attempted,
    staged,
    placement,
    oversize,
    compile,
    poolCold,
    poolReason,
    busy,
    providerFault,
    containers,
    builds,
    boot,
    generateSeconds,
  };
}
