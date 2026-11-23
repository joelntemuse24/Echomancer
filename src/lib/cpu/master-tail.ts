/**
 * Mastering the clone CPU tail.
 *
 * ## The tail this fixes
 *
 * Measured on a real 49-minute book: after the last GPU section landed, the
 * book still spent **~93 s** before it was playable (~19% of the book's total
 * time). Three things were responsible, and only one of them is real work:
 *
 *  1. **A page was mastered only after the whole page returned.** A page is up
 *     to 24 sections, so the ffmpeg pass for section 0 of page 1 waited for the
 *     page's last row. Nothing was staged until the page body arrived, so the
 *     CPU had nothing to start on while the GPU was busy.
 *  2. **A fixed ~17 s gap between a finished master and the next page.** The
 *     GPU lease was held while the tick wrote `segments_json`, ran transcript
 *     QA and updated progress, so the next page's POST was issued late. The
 *     tail is that gap multiplied by the number of pages.
 *  3. **7 of 20 master jobs hit a 20 s wall.** A mastered section is a measured
 *     loudnorm pass followed by a linear apply — about 30-45 s of ffmpeg for a
 *     five-minute section on this host. The 20 s that appeared in the report is
 *     not a section-master budget (`masterSectionBuffer` allows 180 s); it is
 *     the *CPU dispatch accept* window, and it fires while a container is still
 *     starting. The task is not lost — the placement is kept — but the tick
 *     reads `accepted` and gives up on the section for that tick, which then
 *     looks like a master timeout and costs another tick.
 *
 * There is deliberately **no** change to what the master does. LUFS normalisation
 * is not redundant with the container's spectral chain: the container applies
 * EQ and leaves loudness to the app (`s2_mastering.S2_SPECTRAL_CHAIN`,
 * `MODAL_S2_MASTERING` at −19 LUFS / −3 dBTP). Removing it would make one
 * section quieter than the last, which is a quality regression, not a speed fix.
 *
 * ## What this module decides
 *
 * Pure functions only, so the policy can be tested without a GPU or ffmpeg:
 *
 *  - {@link masterQueueFromPage} — which indexes a page makes masterable the
 *    moment its rows are staged, so the tick can start ffmpeg before the next
 *    page is even posted.
 *  - {@link isAcceptTimeout} — whether a `deferred` result is "still starting,
 *    come back", not "this section's master failed".
 *  - {@link masterWaitPlan} — how long one tick should keep waiting for a
 *    master it just placed, and what to do when that wait ends.
 *  - {@link tailBudgetReport} — one line saying what the tail cost, so the next
 *    measurement is not another guess.
 */

/** The CPU result a placement can report. Mirrors `CpuRunResult`. */
export type CpuRunResultName =
  | "done"
  | "accepted"
  | "deferred"
  | "failed"
  | "unavailable"
  | "lost"
  | "cancelled";

/**
 * How long to keep re-posting a master whose dispatch only reached `accepted`.
 *
 * `accepted` means the placement lease is held by a container that has not
 * heartbeated yet — a cold start, not a failed pass. `postCpuPlacement` already
 * retries a 429 until `CPU_DISPATCH_BUSY_MS`, but it returns `accepted` on the
 * first accept timeout, and the tick then treats the section as backlogged.
 * Re-running the same task id is safe by construction: the row is owner-fenced,
 * a live claim is never re-claimed (`claimCpuTask` requires the lease to have
 * expired), and `resultFromRow` returns `accepted` while it is still live. So
 * the retry cannot produce a second ffmpeg for the same section.
 */
export const MASTER_ACCEPT_RETRIES_DEFAULT = 2;

export function masterAcceptRetries(env: NodeJS.ProcessEnv = process.env): number {
  const text = (env.TTS_MASTER_ACCEPT_RETRIES ?? "").trim();
  // `Number("")` is 0, which would read as "never retry" from an unset
  // variable. Empty must mean the default, not zero.
  if (!text) return MASTER_ACCEPT_RETRIES_DEFAULT;
  const raw = Number(text);
  const chosen = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : MASTER_ACCEPT_RETRIES_DEFAULT;
  return Math.min(4, chosen);
}

/**
 * The indexes a page makes masterable now.
 *
 * A page stages its rows all at once, but the page is the GPU's unit, not the
 * CPU's: `stageSection` writes each take into the cache the moment the row
 * exists, so by the time the page body is in hand every row is already
 * masterable. Publishing them one page at a time is what made section 0 of a
 * 24-row page wait for row 23.
 *
 * `alreadyPublished` is what keeps this from doing duplicate work: a section
 * whose master was already placed is not placed again, because `enqueueCpuTask`
 * with the same id and the same `input_path` is a no-op for a `done` row and
 * reuses the in-flight claim otherwise.
 */
export function masterQueueFromPage(input: {
  pageIndexes: readonly number[];
  staged: ReadonlySet<number>;
  alreadyPublished: ReadonlySet<number>;
  /** Playback order requires the *lowest* unready index to be masterable first. */
  lowestUnready: number;
}): { indexes: number[]; blockedBy: number | null } {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const index of [...input.pageIndexes].sort((a, b) => a - b)) {
    if (seen.has(index)) continue;
    seen.add(index);
    if (input.alreadyPublished.has(index)) continue;
    if (!input.staged.has(index)) continue;
    out.push(index);
  }
  // A hole in front means a later section would be published ahead of it.
  // The section itself is still mastered (the work is not wasted and the row
  // becomes `ready`); only its *publication* is ordered by the caller.
  const blockedBy =
    out.length > 0 && input.lowestUnready < Math.min(...out) ? input.lowestUnready : null;
  return { indexes: out, blockedBy };
}

/**
 * Whether a `deferred` result is a busy container rather than a bad section.
 *
 * `runCpuTask` returns `deferred` for two different things: a saturated host
 * (`tryCpuSlot` had no permit, nothing was posted) and a placement that is
 * still starting. The section is not at fault either way, so neither may fail
 * it — but only the saturated case means "do not retry in this tick".
 */
export function isAcceptTimeout(result: CpuRunResultName): boolean {
  return result === "deferred";
}

/** What one master placement achieved, for the tick's decision. */
export type MasterOutcome =
  | { kind: "ready" }
  | { kind: "queued"; reason: "accepted" | "deferred" | "unavailable" }
  | { kind: "failed"; reason: string };

/**
 * Decide what to do after {@link MASTER_ACCEPT_RETRIES} extra attempts.
 *
 * A section that is still `accepted` is queued and *not* failed: the container
 * holds the placement and `promoteFinishedSections` publishes it when it lands.
 * A `failed` master is the only case that stops the book, and it is the master
 * task's own message (`masterSectionBuffer` returning nothing, or ffmpeg
 * exiting non-zero), never "timed out".
 */
export function decideMasterOutcome(input: {
  result: CpuRunResultName;
  attemptsLeft: number;
  outputExists: boolean;
  error?: string | null;
}): MasterOutcome {
  if (input.result === "done") {
    return input.outputExists ? { kind: "ready" } : { kind: "failed", reason: "master published no object" };
  }
  if (input.result === "failed" || input.result === "cancelled") {
    return {
      kind: "failed",
      reason: input.error?.trim() || (input.result === "cancelled" ? "master was cancelled" : "mastering did not finish"),
    };
  }
  if (input.result === "lost") {
    // Owner-fenced: another worker took the row. Its result is the real one.
    return { kind: "queued", reason: "accepted" };
  }
  if (input.result === "unavailable") return { kind: "queued", reason: "unavailable" };
  if (input.result === "accepted") return { kind: "queued", reason: "accepted" };
  // `deferred` with attempts left means the host was saturated and the caller
  // may re-post; with none left it is a genuine backlog for the next tick.
  return input.attemptsLeft > 0
    ? { kind: "queued", reason: "accepted" }
    : { kind: "queued", reason: "deferred" };
}

/**
 * One line describing what the CPU tail cost, mirroring the GPU page log.
 *
 * `gpu_wall_ms` is the dispatch's wall, `tail_ms` is from the last page's last
 * staged row to the last section being ready. The reported incident was a
 * 93 s tail on a 397 s GPU wall; putting both on one line is what makes the
 * next measurement comparable instead of another anecdote.
 */
export interface TailReport {
  jobId?: string | null;
  sections: number;
  gpuWallMs: number;
  tailMs: number;
  /** Sections whose master was placed by this tick. */
  placed: number;
  /** Sections that were already `mastering` and only needed promoting. */
  promoted: number;
  /** Masters still queued at the end of the tick, by reason. */
  queued: number;
  failed: number;
  /** Masters that reported `accepted` at least once. */
  acceptRetries: number;
}

export function formatTailReport(input: TailReport): string {
  const gpu = Math.max(0, input.gpuWallMs) / 1000;
  const tail = Math.max(0, input.tailMs) / 1000;
  const pct = gpu > 0 ? (tail / (gpu + tail)) * 100 : null;
  return [
    "[S2 tail]",
    `job=${input.jobId || "-"}`,
    `sections=${input.sections}`,
    `gpu_wall=${gpu.toFixed(1)}s`,
    `tail=${tail.toFixed(1)}s`,
    `tail_share=${pct == null ? "-" : `${pct.toFixed(0)}%`}`,
    `placed=${input.placed}`,
    `promoted=${input.promoted}`,
    `queued=${input.queued}`,
    `failed=${input.failed}`,
    `accept_retries=${input.acceptRetries}`,
  ].join(" ");
}

export function logTailReport(
  input: TailReport,
  log: (message: string) => void = (message) => console.log(message)
): void {
  try {
    log(formatTailReport(input));
  } catch {
    // A logger must never fail a tick that already published audio.
  }
}

/**
 * How long a tick waits, between promoting masters it already placed, before
 * it decides to hand the book back.
 *
 * This is **not** an in-tick wait for the whole master. The book keeps yielding
 * so another book can have the host — that is the fairness rule and it is not
 * negotiable for a few seconds of tail. What this replaces is the *drain
 * interval*: `CpuBacklogError` released the lease with `CPU_YIELD_SEC` of
 * delay, and the drain then picked the book up on its next 15 s tick. For a
 * section whose master was going to finish in two seconds, that was ~17 s of
 * the book's wall time spent waiting for a timer.
 *
 * So the tick promotes once, waits this long, promotes again, and hands back if
 * the master is still running. A master that finishes inside the wait is
 * published in this tick and the book does not round-trip through the queue at
 * all. Anything longer keeps its claim and is promoted next tick, exactly as
 * today — the `CPU_YIELD_SEC` delay below is removed because the work is
 * already in flight, so 3 s of self-imposed delay is pure loss.
 */
export const MASTER_SETTLE_DEFAULT_MS = 10_000;
export const MASTER_SETTLE_MIN_MS = 0;
export const MASTER_SETTLE_MAX_MS = 30_000;

export function masterSettleMs(env: NodeJS.ProcessEnv = process.env): number {
  const text = (env.TTS_MASTER_SETTLE_MS ?? "").trim();
  // Empty must mean the default: `Number("")` is 0 and would read as "never
  // wait", which is the bug this whole module exists to avoid.
  if (!text) return MASTER_SETTLE_DEFAULT_MS;
  const raw = Number(text);
  const chosen = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : MASTER_SETTLE_DEFAULT_MS;
  return Math.min(MASTER_SETTLE_MAX_MS, Math.max(MASTER_SETTLE_MIN_MS, chosen));
}

/**
 * Whether the tick should spend {@link masterSettleMs} before handing back.
 *
 * A queued book waiting for this host is the one reason not to: its turn is
 * worth more than this tick's last few seconds, and these masters are promoted
 * on the next tick anyway. `0` disables the settle entirely.
 */
export function shouldSettleMasters(input: {
  outstanding: number;
  anotherBookWaiting: boolean;
  stopAt?: number | null;
  now: number;
  settleMs: number;
}): boolean {
  if (input.settleMs <= 0) return false;
  if (input.outstanding <= 0) return false;
  if (input.anotherBookWaiting) return false;
  if (input.stopAt != null && input.now >= input.stopAt) return false;
  return true;
}

