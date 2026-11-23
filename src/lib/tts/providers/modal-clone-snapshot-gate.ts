/**
 * Should a clone book wait for the GPU, or take a flagged fallback?
 *
 * ## The bug this replaces
 *
 * PR #324 gated a book on `provedCold`:
 *
 * ```ts
 * provedCold: !ready && sawWarmCount && warm <= 0
 * ```
 *
 * `/ready` reports `warm_containers` as `len(_live_containers(build))` — only
 * containers that have **finished restoring**. So on an idle `min_containers=0`
 * pool, where every container has scaled away, the answer is `ready: false,
 * warm_containers: 0`. That is the *normal resting state* of the app, not
 * evidence that a placement would compile.
 *
 * Treating it as proof refused the GPU and routed the book to hosted Fish,
 * which costs 3–5× the self-hosted H100 and is what the whole clone path exists
 * to avoid. It also fires exactly when nobody is watching: the first book after
 * an idle period.
 *
 * ## What the decision actually needs
 *
 * Two different questions, and only one of them may change the engine:
 *
 *  1. **Is a container recorded or building?** If this build has a recorded
 *     snapshot, a placement restores. If one is starting, it is already
 *     underway and finishing it is cheaper than switching. If neither, a
 *     placement would compile — and *that* is the expensive case.
 *  2. **Is a fallback even available and permitted?** A fallback to Fish is the
 *     same voice, but it is a different engine and a different price. It is
 *     opt-in, never automatic.
 *
 * So the default is **WAIT**. A book that waits costs nothing but wall clock,
 * and the worker's own `MODAL_S2_DEFER_MS` clock already makes the fallback
 * reachable after 25 minutes of genuinely nothing. A flagged exception exists
 * for the operator who would rather spend 3–5× than wait through a compile, and
 * it is off unless set.
 *
 * ## What this module does not claim
 *
 * An idle pool with no recorded snapshot is *not* proof that a placement would
 * compile. The marker may be absent because the build predates it, because the
 * Dict write failed, or because a deploy invalidated snapshots without the
 * marker being cleared. `snapshotRecorded: false` therefore only means
 * "nothing here proves a restore", and the decision treats it as *unknown*
 * rather than as a compile — a book waits, and the placement's own restore
 * budget decides.
 */

/** A `/ready` body, as much of it as the decision reads. */
export interface SnapshotGateProbe {
  /** The HTTP call answered. A timeout or a 404 is not an answer. */
  answered: boolean;
  /** The route exists at all. A pre-`/ready` build reports false. */
  routePresent: boolean;
  ready: boolean;
  warmContainers: number;
  /** Containers placed but not yet restored. `null` when not reported. */
  startingContainers: number | null;
  /**
   * The build reported a recorded snapshot. `null` means the field is absent,
   * which is not the same as `false`: a build from before the field cannot
   * answer, and must not be treated as "would compile".
   */
  snapshotRecorded: boolean | null;
  build: string | null;
}

export type SnapshotGateReason =
  | "warm"
  | "starting"
  | "recorded-snapshot"
  | "idle-unknown"
  | "probe-unanswered"
  | "route-absent";

/** Which way a book should go, and why. */
export type SnapshotGateDecision =
  /** Place on the GPU: a container is warm, or a restore is already underway. */
  | { action: "use-gpu"; reason: SnapshotGateReason }
  /**
   * Park on the defer clock and come back. This is the default for every
   * uncertain answer, and it is not a failure.
   */
  | { action: "wait"; reason: SnapshotGateReason }
  /**
   * Take the flagged fallback. Only reachable with
   * `MODAL_S2_SNAPSHOT_BUILD_FALLBACK=1` and only when nothing is recorded and
   * nothing is starting.
   */
  | { action: "fallback"; reason: SnapshotGateReason };

/**
 * Would a placement now have to build a snapshot?
 *
 * `starting` is decided first: a container that is already restoring or
 * building means the expensive work is *already happening*, so switching
 * engines would not save it — it would only add a second bill.
 *
 * `snapshotRecorded` alone decides the rest. `null` (absent) is *unknown*, not
 * *no*, because a build from before the field cannot answer.
 */
export function classifySnapshotGate(probe: SnapshotGateProbe): SnapshotGateDecision {
  if (!probe.routePresent) return { action: "wait", reason: "route-absent" };
  if (!probe.answered) return { action: "wait", reason: "probe-unanswered" };
  if (probe.ready && probe.warmContainers > 0) return { action: "use-gpu", reason: "warm" };
  // A placement already in flight. Finishing it is the cheapest thing to do,
  // and it is precisely what a `warm_containers: 0` count hides.
  if (probe.startingContainers != null && probe.startingContainers > 0) {
    return { action: "use-gpu", reason: "starting" };
  }
  if (probe.snapshotRecorded === true) {
    // No container is up, but this build can restore. That is an ordinary cold
    // start, and a book waits for it.
    return { action: "wait", reason: "recorded-snapshot" };
  }
  // Idle, and nothing proves whether a placement would restore or compile.
  // Waiting is free; guessing costs either a compile or a 3-5x fallback.
  return { action: "wait", reason: "idle-unknown" };
}

/** `MODAL_S2_SNAPSHOT_BUILD_FALLBACK=1` opts in to the expensive shortcut. */
export function snapshotBuildFallbackEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return (env.MODAL_S2_SNAPSHOT_BUILD_FALLBACK ?? "").trim() === "1";
}

/**
 * The decision to act on, with the opt-in applied.
 *
 * Kept separate from {@link classifySnapshotGate} so the classifier stays a
 * pure statement about the pool and the policy is one readable line. A fallback
 * is only ever reached when the pool is idle *and* the fallback is explicitly
 * enabled: an uncertain probe never becomes a fallback, even with the flag on.
 */
export function decideSnapshotGate(
  probe: SnapshotGateProbe,
  env: NodeJS.ProcessEnv = process.env
): SnapshotGateDecision {
  const decision = classifySnapshotGate(probe);
  if (decision.action !== "wait") return decision;
  // `idle-unknown` is the only wait a fallback could ever replace. A recorded
  // snapshot is a normal cold start, and a probe that did not answer says
  // nothing at all.
  if (decision.reason !== "idle-unknown") return decision;
  if (!snapshotBuildFallbackEnabled(env)) return decision;
  return { action: "fallback", reason: "idle-unknown" };
}

/** True when this decision lets a GPU call be posted. */
export function gateAllowsGpu(decision: SnapshotGateDecision): boolean {
  return decision.action === "use-gpu";
}

/**
 * One line saying what was decided and why, so the next incident has a record.
 * The `warm`/`starting` pair is what made the old gate wrong, so both are on
 * the line even when the answer came from the marker.
 */
export function formatSnapshotGateLog(
  probe: SnapshotGateProbe,
  decision: SnapshotGateDecision
): string {
  const start =
    probe.startingContainers == null ? "-" : String(probe.startingContainers);
  const marker =
    probe.snapshotRecorded == null ? "unknown" : probe.snapshotRecorded ? "yes" : "no";
  return [
    "[S2 gate]",
    `action=${decision.action}`,
    `reason=${decision.reason}`,
    `answered=${probe.answered ? 1 : 0}`,
    `route=${probe.routePresent ? 1 : 0}`,
    `ready=${probe.ready ? 1 : 0}`,
    `warm=${probe.warmContainers}`,
    `starting=${start}`,
    `snapshot=${marker}`,
    `build=${probe.build || "-"}`,
  ].join(" ");
}
