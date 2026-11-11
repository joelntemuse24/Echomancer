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
  modalClonePoolIsWarm,
  noteModalClonePoolLost,
  rememberModalCloneCold,
  type CloneBatchItem,
  type CloneBatchOutcome,
} from "@/lib/tts/providers/modal-clone";
import { ModalWorkspaceDisabledError } from "@/lib/modal/workspace-disabled";
import { kickModalCloneSnapshotWarm } from "@/lib/tts/providers/modal-clone-warm";
import {
  MODAL_LANE_CHARS_PER_SECOND,
  MODAL_LANE_WARM_PACK_CHARS_PER_SECOND,
  modalLaneWorkMs,
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
   * One restored H100. The first call stays cold-sized (section 0 when this
   * book has not played yet). Once that returns, the next call fills one
   * batch. Later ticks stay fat while {@link modalClonePoolIsWarm} is true,
   * and drop back to a cold-sized call when the container has scaled away.
   * Calls run one at a time. Omit this and the older multi-lane planner runs.
   */
  bookWave?: boolean;
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
  poolCold: boolean;
  poolReason: string;
  busy: number;
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
  poolCold: boolean;
  poolReason: string;
  busy: number;
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
    poolCold: false,
    poolReason: "",
    busy: 0,
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
  tally.busy += wave.busy;
  tally.containers.push(...wave.containers);
  tally.builds.push(...wave.builds);
  tally.boot.push(...wave.boot);
  tally.generateSeconds += wave.generateSeconds;
  if (wave.poolCold) {
    tally.poolCold = true;
    tally.poolReason = wave.poolReason;
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
 * stays small. The call after a successful first light fills one batch, and
 * it is not started until that first call has audio. A warm batch that
 * misses its budget is retried as one section and the rest waits for the
 * next tick, so this book does not open a second GPU.
 */
async function dispatchBookWave(opts: LaneDispatchOptions): Promise<LaneDispatchResult> {
  const log = opts.log ?? (() => {});
  const tally = emptyTally();
  let firstLight: FirstLightReport | null = null;
  let publishing: Promise<void> | null = null;
  const publishState: { error: unknown } = { error: null };
  const poolWarm = opts.poolWarm ?? modalClonePoolIsWarm();
  const plan = planModalCloneBookWave({
    pending: opts.indexes,
    textAt: opts.textAt,
    firstLight: opts.firstLight === true,
    poolWarm,
    batch: opts.batch,
  });
  log(
    `[S2 lanes] book wave pool=${poolWarm ? "warm" : "cold"} ` +
      (plan.calls.map((call) => `${call.shape}:${call.indexes.length}`).join(" then ") || "idle")
  );

  for (let i = 0; i < plan.calls.length; i++) {
    const call = plan.calls[i]!;
    const isHead = opts.firstLight === true && i === 0 && call.shape === "cold";
    const startedAt = Date.now();
    const wave = await runWave(opts, call.indexes, log, 1, isHead, undefined, {
      maxLaneChars: Number.POSITIVE_INFINITY,
      warmBatch: call.shape === "warm",
    });
    mergeWave(tally, wave);

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
      if (opts.publishFirstLight) {
        publishing = opts.publishFirstLight(head).catch((err: unknown) => {
          publishState.error = err;
        });
      }
      continue;
    }

    if (wave.poolCold) break;

    if (!wave.poolCold && wave.oversize.length > 0) {
      const split = wave.oversize.filter((index) => !tally.staged.has(index));
      if (split.length > 0) {
        const one = split.slice(0, 1);
        log(
          `[S2 lanes] ${call.shape} batch missed its budget; retrying [${one.join(",")}] and leaving the rest`
        );
        mergeWave(
          tally,
          await runWave(opts, one, log, 1, false, 1, {
            maxLaneChars: Number.POSITIVE_INFINITY,
            warmBatch: false,
          })
        );
      }
      break;
    }

    if (call.shape === "cold" && !wave.poolCold && wave.placement.length > 0) {
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
  }

  return finishDispatch(tally, firstLight, publishing, publishState, log);
}

async function finishDispatch(
  tally: DispatchTally,
  firstLight: FirstLightReport | null,
  publishing: Promise<void> | null,
  publishState: { error: unknown },
  log: (message: string) => void
): Promise<LaneDispatchResult> {
  const sawPlacement = tally.placement.length > 0;
  if (sawPlacement) {
    // A one-section call that never came back is a placement that missed: the
    // HTTP call already gave up, and the RPC is what is allowed to finish a
    // possible compile. A multi-section miss is oversize, not placement, so a
    // warm batch that ran long does not kick a compile.
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
  wave?: { maxLaneChars?: number; warmBatch?: boolean }
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
  const placement: number[] = [];
  const oversize: number[] = [];

  if (attempted.length === 0) {
    return {
      attempted,
      staged,
      placement,
      oversize,
      poolCold,
      poolReason,
      busy,
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
      const slot = await holdModalCloneLaneSlot(modalCloneLanes());
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
          const outcome = await opts.render(
            page.map((index) => ({ key: String(index), text: opts.textAt(index) })),
            opts.seedEpoch,
            {
              raceForFirstAudio: races,
              workMs: modalLaneWorkMs(
                pageChars,
                largestRow,
                wave?.warmBatch
                  ? MODAL_LANE_WARM_PACK_CHARS_PER_SECOND
                  : MODAL_LANE_CHARS_PER_SECOND
              ),
              warmBatch: wave?.warmBatch === true,
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
        if (wave?.warmBatch) noteModalClonePoolLost();
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
      else placement.push(...missed);
    } else if (err instanceof ModalCloneColdError) {
      poolCold = true;
      poolReason = err.message;
    } else if (err instanceof ModalCloneLaneBusyError) {
      // Another lane is rendering in that container. This is neither cold nor
      // fatal: the sections stay unclaimed so a later tick picks them up.
      busy += 1;
      log(`[S2 lanes] lane busy: ${err.message}`);
    } else {
      log(`[S2 lanes] lane failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    attempted,
    staged,
    placement,
    oversize,
    poolCold,
    poolReason,
    busy,
    containers,
    builds,
    boot,
    generateSeconds,
  };
}
