/**
 * Rolling pool for the Kokoro CPU voices (Drew, Walter, George).
 *
 * One lane is one HTTP call to the `echomancer-sowell` Modal app, and Modal
 * starts one container per concurrent call. The old dispatch claimed sections
 * in fixed pairs and waited for both before it claimed the next pair, so a
 * lane sat idle while the slower section of its pair finished. The Edge path
 * already used a rolling pool (`runRollingIndexPool`); this is the same shape
 * with two differences the CPU voices need:
 *
 * 1. **Mastering is detached.** Once a section's speech is stored, the lane
 *    is free: the podcast chain (ffmpeg) and the segment write run on their
 *    own promise while the lane starts the next section. Mastering six
 *    sections back-to-back cost more wall time than rendering them.
 * 2. **Every render and master is reported**, so a test can prove no lane
 *    idled while work remained, and that mastering overlapped rendering.
 *
 * Ordering is unchanged: a section is bound to its index before it starts,
 * results are keyed by index, and the final join still walks `0..N-1`.
 */

export type KokoroPoolEvent =
  | { type: "render-start"; index: number; at: number }
  | { type: "render-end"; index: number; at: number }
  | { type: "master-start"; index: number; at: number }
  | { type: "master-end"; index: number; at: number; ok: boolean };

export interface RollingRenderPoolOptions<T> {
  /** Lanes to keep busy. One lane is one container. */
  lanes: number;
  /**
   * Claim the next index. Returns `null` when nothing is left this tick.
   * Called only when a lane is free, so it may write the resume cursor.
   */
  claimNext: () => Promise<number | null>;
  /** Speech only. The lane stays busy until this resolves. */
  render: (index: number) => Promise<T>;
  /**
   * Mastering and the segment write. Started as soon as `render` returns and
   * **not awaited by the lane**, so the next section renders concurrently.
   */
  afterRender: (index: number, value: T) => Promise<void>;
  /**
   * Lanes this book may hold **right now**, re-read before every claim.
   *
   * A book alone gets the whole fleet; two books split it; a book that joins
   * later is counted on the next claim, so it gets lanes as other books'
   * sections finish instead of waiting for their whole wave. A lane above the
   * budget parks until another book's section frees a container (or the book
   * runs out of work), so a shrinking share never idles a container and the
   * whole fleet is never held by one book. Omit this for an unshared pool
   * (Edge, tests).
   */
  laneBudget?: () => Promise<number>;
  /** Checked before every claim so a tick can stop near its deadline. */
  shouldStop?: () => boolean;
  /** Test seam. Production passes nothing. */
  now?: () => number;
  onEvent?: (event: KokoroPoolEvent) => void;
}

export interface RollingRenderPoolResult<T> {
  /** Render results by index, in ascending index order. */
  rendered: T[];
  /** The indexes that rendered, ascending. */
  indexes: number[];
  /** Highest number of renders that ran at the same time. */
  peakRenders: number;
}

/**
 * Run a rolling render pool. Resolves after every detached mastering promise
 * has settled, so the caller can read the final segment map and join.
 *
 * A render rejection stops the pool and is rethrown after in-flight renders
 * and masters settle, exactly like `Promise.all` over the old workers. A
 * mastering rejection is rethrown the same way; the section row it would have
 * written is recovered by `recoverOrphanRawSections` on the next tick.
 */
export async function runRollingRenderPool<T>(
  opts: RollingRenderPoolOptions<T>
): Promise<RollingRenderPoolResult<T>> {
  const lanes = Math.max(1, Math.floor(opts.lanes) || 1);
  const now = opts.now ?? (() => Date.now());
  const emit = opts.onEvent ?? (() => {});
  const results = new Map<number, T>();
  const background = new Set<Promise<void>>();
  const masterErrors: unknown[] = [];
  let rendered = 0;
  let peakRenders = 0;
  let stopping = false;
  /** Lanes currently holding (or claiming) a container. */
  let activeLanes = 0;

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  /**
   * How many lanes this book may hold now.
   *
   * Read at claim time only (once per lane per section, not per poll), so the
   * split follows books starting and finishing without a cache. A failed read
   * falls back to the planned lane count — a broken counter must not stall
   * the book — and the shared `kokoro` permit is still the hard cap.
   */
  async function currentBudget(): Promise<number> {
    if (!opts.laneBudget) return lanes;
    try {
      const next = Math.floor(await opts.laneBudget());
      return Number.isFinite(next) && next >= 1 ? Math.min(next, lanes) : lanes;
    } catch {
      return lanes;
    }
  }

  async function drainBackground(): Promise<void> {
    while (background.size > 0) {
      await Promise.allSettled([...background]);
    }
  }

  async function lane(): Promise<void> {
    let waitMs = 100;
    while (!stopping) {
      if (opts.shouldStop?.()) {
        stopping = true;
        break;
      }
      // Read the budget, then check and take the slot with no await between
      // them, so two lanes cannot both pass a budget with room for one.
      const budget = await currentBudget();
      if (activeLanes >= budget) {
        // The whole fleet is shared with other books right now. Wait instead
        // of exiting: another book's section may finish and give this book a
        // lane back without waiting for this tick to end. A book with no work
        // left sets `stopping` on the lane that claims `null`, so these
        // waiters exit too.
        await sleep(waitMs);
        waitMs = Math.min(1_000, waitMs * 2);
        continue;
      }
      waitMs = 100;
      activeLanes += 1;
      try {
        const index = await opts.claimNext();
        if (index === null) {
          stopping = true;
          break;
        }
        rendered += 1;
        peakRenders = Math.max(peakRenders, rendered);
        emit({ type: "render-start", index, at: now() });
        let value: T;
        try {
          value = await opts.render(index);
          results.set(index, value);
        } finally {
          rendered -= 1;
          emit({ type: "render-end", index, at: now() });
        }
        // The lane is free now. Mastering runs on its own promise, and its
        // rejection is kept for the caller instead of surfacing as an
        // unhandled rejection in the middle of the next render. A failed
        // store — a lost lease, a refused CPU placement — also stops new
        // claims, so the pool does not keep speaking sections whose rows can
        // no longer be written.
        const master: Promise<void> = (async () => {
          emit({ type: "master-start", index, at: now() });
          let ok = false;
          try {
            await opts.afterRender(index, value);
            ok = true;
          } catch (err) {
            masterErrors.push(err);
            stopping = true;
          } finally {
            emit({ type: "master-end", index, at: now(), ok });
          }
        })();
        const tracked = master.finally(() => background.delete(tracked));
        background.add(tracked);
      } finally {
        activeLanes -= 1;
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: lanes }, () => lane()));
  } finally {
    // A failed lane must not leave a mastering write in flight behind it:
    // the caller is about to re-read the segment map.
    await drainBackground();
  }

  if (masterErrors.length > 0) throw masterErrors[0];

  const indexes = [...results.keys()].sort((a, b) => a - b);
  return { rendered: indexes.map((index) => results.get(index)!), indexes, peakRenders };
}
/**
 * Lanes one Kokoro book may use, given how many Kokoro books are running.
 *
 * `fleet` is the shared budget: the deployed `max_containers`. The `kokoro`
 * provider-slot rows are the hard cross-process cap; this split is what keeps
 * one book from holding every container for the whole of its wave.
 *
 * The fleet is divided **exactly**, oldest book first:
 *
 *   1 book  → 16 lanes         (alone, a book gets everything)
 *   2 books → 8 + 8
 *   3 books → 6 + 5 + 5        (the remainder goes to the older books)
 *
 * Those fair shares sum to `fleet`. A book then keeps the smallest share
 * that does not add a wave (`lanesForSameWaves`): 22 sections on a quota of
 * 16 is two waves either at 16 lanes or at 11, and the five containers that
 * would have spoken once and idled are not started. A book ranked past the
 * fleet still gets one lane; the slot rows serialise the overflow.
 * `configured` (`SOWELL_BOOK_LANES`) is a per-book ceiling below the split.
 */
export function kokoroFairQuota(input: {
  configured: number;
  fleet: number;
  activeBooks: number;
  /** Zero-based rank among the active books, oldest first. Defaults to 0. */
  rank?: number;
}): number {
  const configured = Math.max(1, Math.floor(input.configured) || 1);
  const fleet = Math.max(1, Math.floor(input.fleet) || 1);
  const books = Math.max(1, Math.floor(input.activeBooks) || 1);
  const rank = Math.max(0, Math.floor(input.rank ?? 0) || 0);
  const base = Math.floor(fleet / books);
  const remainder = fleet % books;
  const quota = base + (rank < remainder ? 1 : 0);
  return Math.max(1, Math.min(configured, quota || 1));
}

/**
 * Fewest lanes that keep `ceil(sections / lanes) === ceil(sections / quota)`.
 *
 * A smaller count boots fewer containers. It does not add a wave, so a book
 * of equal sections still finishes in the same number of section-times.
 */
export function lanesForSameWaves(sections: number, quota: number): number {
  const count = Math.max(0, Math.floor(sections) || 0);
  const cap = Math.max(1, Math.min(Math.floor(quota) || 1, count || 1));
  if (count < 1) return 1;
  const waves = Math.ceil(count / cap);
  return Math.max(1, Math.min(cap, Math.ceil(count / waves)));
}

export function planKokoroBookLanes(input: {
  configured: number;
  fleet: number;
  activeBooks: number;
  remainingSections: number;
  /** Zero-based rank among the active books, oldest first. Defaults to 0. */
  rank?: number;
}): number {
  const sections = Math.max(0, Math.floor(input.remainingSections) || 0);
  if (sections < 1) return 1;
  return lanesForSameWaves(sections, kokoroFairQuota(input));
}
