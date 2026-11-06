/**
 * Lane dispatch for the self-hosted S2-Pro clone path.
 *
 * The book is asynchronous: the browser is not holding a request open, so
 * "the GPU pool has not restored yet" is a reason to come back later, not a
 * reason to switch narrator. This module owns that decision so the tick loop
 * only has to act on the answer.
 *
 * Two rules, both learned the hard way:
 *   - A book may wait for a snapshot restore. It must not wait for a compile.
 *     One placement that misses the restore budget is dropped; the unstaged
 *     sections are tried once on another container. Only when nothing comes
 *     back does the book park, and the compile itself is an off-path RPC.
 *   - A book never changes engine mid-way. The pin is decided once and stored,
 *     and the only way it changes is the defer budget running out — which also
 *     writes a warning the person can see.
 */

import {
  ModalCloneColdError,
  ModalCloneLaneBusyError,
  rememberModalCloneCold,
  type CloneBatchItem,
  type CloneBatchOutcome,
} from "@/lib/tts/providers/modal-clone";
import { kickModalCloneSnapshotWarm } from "@/lib/tts/providers/modal-clone-warm";
import { planModalCloneLanes, pageLane } from "@/lib/tts/providers/modal-clone-lanes";

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
  /** One HTTP batch call. Rejects with ModalCloneColdError on a cold pool. */
  render: (items: CloneBatchItem[], seedEpoch: number) => Promise<CloneBatchOutcome>;
  /** Persist a rendered section (section cache + any bookkeeping). */
  stage: (index: number, audio: Buffer, durationSeconds: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface LaneDispatchResult {
  /** Indexes rendered and staged by this dispatch. */
  staged: number;
  /** Indexes that were planned but produced no audio this time. */
  missing: number[];
  /** True when the pool had nothing warm and the book should be parked. */
  cold: boolean;
  /** Lanes that found their container already rendering. Retryable, not cold. */
  busy: number;
  /** Containers that answered, and the builds they reported. */
  containers: string[];
  builds: string[];
  /** Sum of the server's measured generation seconds, for the tick log. */
  generateSeconds: number;
}

interface WaveOutcome {
  attempted: number[];
  staged: Set<number>;
  /** Indexes whose container missed the restore budget. */
  placement: number[];
  poolCold: boolean;
  poolReason: string;
  busy: number;
  containers: string[];
  builds: string[];
  generateSeconds: number;
}

/**
 * Render every planned lane and stage what comes back.
 *
 * Lanes run at once, so one compiling variant does not hold the others. A
 * placement that misses the restore budget is tried once more on another
 * container. A probe that says the pool is empty is not retried: more HTTP
 * calls would each wait the same budget and still could not finish a compile.
 */
export async function dispatchModalCloneLanes(
  opts: LaneDispatchOptions
): Promise<LaneDispatchResult> {
  const log = opts.log ?? (() => {});
  const first = await runWave(opts, opts.indexes, log);
  if (first.attempted.length === 0) {
    return emptyDispatch();
  }

  const staged = first.staged;
  let placement = first.placement;
  let poolCold = first.poolCold;
  let poolReason = first.poolReason;
  let busy = first.busy;
  const containers = [...first.containers];
  const builds = [...first.builds];
  let generateSeconds = first.generateSeconds;
  const sawPlacement = placement.length > 0;

  // One extra wave, not a loop. Two restore budgets is still not a compile.
  if (!poolCold && placement.length > 0) {
    log(`[S2 lanes] placement missed restore budget; retrying [${placement.join(",")}]`);
    const second = await runWave(opts, placement, log);
    for (const index of second.staged) staged.add(index);
    placement = second.placement.filter((index) => !staged.has(index));
    busy += second.busy;
    containers.push(...second.containers);
    builds.push(...second.builds);
    generateSeconds += second.generateSeconds;
    if (second.poolCold) {
      poolCold = true;
      poolReason = second.poolReason;
    }
  }

  if (sawPlacement || placement.length > 0) {
    // The HTTP call already gave up. The RPC is what is allowed to finish.
    kickModalCloneSnapshotWarm("placement exceeded restore budget");
  }

  const cold = poolCold || (placement.length > 0 && staged.size === 0);
  if (!poolCold && placement.length > 0) {
    // Do not open another restore-budget wait for the holes in this tick.
    rememberModalCloneCold();
  }
  if (cold) log(`[S2 lanes] cold pool: ${poolReason || "placement missed restore budget"}`);

  return {
    staged: staged.size,
    missing: first.attempted.filter((index) => !staged.has(index)),
    cold,
    busy,
    containers: [...new Set(containers)],
    builds: [...new Set(builds)],
    generateSeconds: Math.round(generateSeconds * 10) / 10,
  };
}

function emptyDispatch(): LaneDispatchResult {
  return {
    staged: 0,
    missing: [],
    cold: false,
    busy: 0,
    containers: [],
    builds: [],
    generateSeconds: 0,
  };
}

async function runWave(
  opts: LaneDispatchOptions,
  indexes: number[],
  log: (message: string) => void
): Promise<WaveOutcome> {
  const plan = planModalCloneLanes({
    pending: indexes,
    textAt: opts.textAt,
    limits: {
      lanes: opts.lanes,
      batch: opts.batch,
      maxLaneChars: opts.maxLaneChars,
    },
  });
  const attempted = plan.lanes.flat();
  const staged = new Set<number>();
  const containers: string[] = [];
  const builds: string[] = [];
  let generateSeconds = 0;
  let poolCold = false;
  let poolReason = "";
  let busy = 0;
  const placement: number[] = [];

  if (attempted.length === 0) {
    return {
      attempted,
      staged,
      placement,
      poolCold,
      poolReason,
      busy,
      containers,
      builds,
      generateSeconds,
    };
  }

  const laneResults = await Promise.all(
    plan.lanes.map(async (lane) => {
      const stagedHere: number[] = [];
      try {
        for (const page of pageLane(lane, opts.batch)) {
          const outcome = await opts.render(
            page.map((index) => ({ key: String(index), text: opts.textAt(index) })),
            opts.seedEpoch
          );
          if (outcome.containerId) containers.push(outcome.containerId);
          if (outcome.build) builds.push(outcome.build);
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
          log(`[S2 lanes] page of ${page.length} rendered ${rendered}/${page.length}`);
          if (rendered < page.length) break;
        }
        return { lane, error: null as unknown };
      } catch (error) {
        return { lane, error };
      }
    })
  );

  for (const result of laneResults) {
    const err = result.error;
    if (!err) continue;
    if (err instanceof ModalCloneColdError && err.scope === "placement") {
      for (const index of result.lane) {
        if (!staged.has(index)) placement.push(index);
      }
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
    poolCold,
    poolReason,
    busy,
    containers,
    builds,
    generateSeconds,
  };
}
