/**
 * Lane dispatch for the self-hosted S2-Pro clone path.
 *
 * The book is asynchronous: the browser is not holding a request open, so
 * "the GPU pool has not restored yet" is a reason to come back later, not a
 * reason to switch narrator. This module owns that decision so the tick loop
 * only has to act on the answer.
 *
 * Two rules, both learned the hard way:
 *   - A cold pool parks the book. Four sections per container is the point of
 *     the lane plan; aborting a restore at 180 s wasted the restore *and* the
 *     GPU minutes spent on it.
 *   - A book never changes engine mid-way. The pin is decided once and stored,
 *     and the only way it changes is the defer budget running out — which also
 *     writes a warning the person can see.
 */

import {
  ModalCloneColdError,
  type CloneBatchItem,
  type CloneBatchOutcome,
} from "@/lib/tts/providers/modal-clone";
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
  /** Containers that answered, and the builds they reported. */
  containers: string[];
  builds: string[];
  /** Sum of the server's measured generation seconds, for the tick log. */
  generateSeconds: number;
}

/**
 * Render every planned lane and stage what comes back.
 *
 * Lanes run at once (the in-process gate is sized to the lane count), so one
 * slow container does not delay the others. A cold answer from any lane stops
 * the dispatch: the remaining lanes would just hit the same cold pool.
 */
export async function dispatchModalCloneLanes(
  opts: LaneDispatchOptions
): Promise<LaneDispatchResult> {
  const plan = planModalCloneLanes({
    pending: opts.indexes,
    textAt: opts.textAt,
    limits: {
      lanes: opts.lanes,
      batch: opts.batch,
      maxLaneChars: opts.maxLaneChars,
    },
  });
  const log = opts.log ?? (() => {});

  const planned = plan.lanes.flat();
  if (planned.length === 0) {
    return {
      staged: 0,
      missing: [],
      cold: false,
      containers: [],
      builds: [],
      generateSeconds: 0,
    };
  }

  const staged = new Set<number>();
  const containers: string[] = [];
  const builds: string[] = [];
  let generateSeconds = 0;
  let cold = false;
  let coldReason = "";

  const laneResults = await Promise.allSettled(
    plan.lanes.map(async (lane) => {
      let rendered = 0;
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
        for (const [key, hit] of outcome.audio) {
          const index = Number(key);
          if (!Number.isInteger(index)) continue;
          await opts.stage(index, hit.audio, hit.durationSeconds);
          staged.add(index);
          rendered += 1;
        }
        // A page that produced nothing for a section leaves it unclaimed, so
        // the per-section path retries it. That is the intended fall-through.
        log(
          `[S2 lanes] page of ${page.length} rendered ${rendered}/${page.length}`
        );
        if (rendered < page.length) break;
      }
      return lane;
    })
  );

  for (const result of laneResults) {
    if (result.status === "rejected") {
      const err = result.reason;
      if (err instanceof ModalCloneColdError) {
        cold = true;
        coldReason = err.message;
      } else {
        log(
          `[S2 lanes] lane failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
  if (cold) log(`[S2 lanes] cold pool: ${coldReason}`);

  return {
    staged: staged.size,
    missing: planned.filter((index) => !staged.has(index)),
    cold,
    containers: [...new Set(containers)],
    builds: [...new Set(builds)],
    generateSeconds: Math.round(generateSeconds * 10) / 10,
  };
}
