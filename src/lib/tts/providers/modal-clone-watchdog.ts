/**
 * First-audio watchdog for the self-hosted clone path.
 *
 * ## What went wrong on 2026-11-22
 *
 * Book `f452bc31` opened its first S2 call at 02:22:33. The container
 * restored, the log said the model was loaded, and then nothing happened:
 * no `synthesize`, no first unit, no `ready`. The worker's own log went
 * silent too. Every ~3 s the CPU control endpoint answered `200` — that is
 * a `pending` poll, not a render — and the job row stayed `processing`
 * indefinitely. Somebody had to cancel the book and stop the GPUs by hand.
 *
 * Two separate failures produced that:
 *
 * 1. The container was still compiling Inductor kernels. The compile-cache
 *    load had failed (`TypeError: a bytes-like object is required, not
 *    'str'`) while the log claimed `hit=hit`, so the restore looked healthy
 *    and the following compile had no owner.
 * 2. Nothing on the book path had an opinion about "no audio after N
 *    seconds". Every wait in this pipeline was sized from *what was sent*
 *    (`workMs` → HTTP wait). A call that never starts rendering consumes
 *    the whole budget, then parks, then is retried, and the book can go on
 *    being retried — visibly "processing" — while an H100 is billed.
 *
 * This module is the missing rule: a book that has produced no audio at
 * all has a bounded wall clock, and when it expires the worker stops paying
 * for the GPU instead of polling it.
 *
 * ## Why the budget is what it is
 *
 * A cold first light is a restore (~57 s measured) plus the opening
 * section's generation at the single-row rate. Production's opening is
 * 1,000 characters at roughly 44 chars/s, so about 64 s of GPU wall, plus
 * ~3 s of publish. That is ~124 s of honest work. The measured cold call on
 * 2026-11-11 was 57 s end-to-end for 673 characters.
 *
 * The default is therefore generous: 240 s covers a restore, the opening,
 * and a slow placement. It is deliberately *not* a compile budget. A
 * placement that needs to compile is the off-path warm's job
 * (`MODAL_S2_WARM_HOOK`), not something a customer's book waits behind,
 * which is the same reason `MODAL_S2_FIRST_LIGHT_WAIT_MS` is 75 s.
 *
 * `MODAL_S2_FIRST_AUDIO_MS=0` disables the trip (rollback). It never
 * disables the *clock*: elapsed time is always reported, so a book that is
 * slow but alive still says so.
 */

/** Honest cold first light, with room for a slow placement. */
export const MODAL_CLONE_FIRST_AUDIO_DEFAULT_MS = 240_000;
/** Never shorter than the first-light HTTP wait: that wait is legitimate work. */
export const MODAL_CLONE_FIRST_AUDIO_MIN_MS = 90_000;
/** One hour. Past this the book is not "slow", and the answer is not a wait. */
export const MODAL_CLONE_FIRST_AUDIO_MAX_MS = 60 * 60_000;

/** How often the race re-reads readiness. The probe is one cheap GET. */
export const MODAL_CLONE_WATCHDOG_POLL_MS = 15_000;

/**
 * Test override for the budget, like `setS2StatusBudgetForTests`.
 *
 * Production reads `MODAL_S2_FIRST_AUDIO_MS`; its floor is 90 s, which is
 * right for a real book and far too slow for a unit test. Tests set a few
 * milliseconds and restore `null` afterwards.
 */
let budgetForTests: number | null = null;

export function setModalCloneFirstAudioBudgetForTests(ms: number | null): void {
  budgetForTests = ms;
}

/** Test override for the readiness poll gap. */
let pollForTests: number | null = null;

export function setModalCloneWatchdogPollForTests(ms: number | null): void {
  pollForTests = ms;
}

/**
 * The bound on "this book has not produced any audio yet".
 *
 * Read once per tick by the clone path. A value of 0 turns the trip off; a
 * malformed value falls back to the default rather than to a dangerous
 * zero. The floor keeps it above the first-light wait, so a healthy cold
 * opening can never be cut by this clock.
 */
export function modalCloneFirstAudioBudgetMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  if (budgetForTests != null) return Math.max(0, Math.floor(budgetForTests));
  const raw = (env.MODAL_S2_FIRST_AUDIO_MS ?? "").trim();
  if (raw === "0") return 0;
  const n = Number(raw);
  const chosen =
    raw && Number.isFinite(n) && n > 0
      ? Math.floor(n)
      : MODAL_CLONE_FIRST_AUDIO_DEFAULT_MS;
  return Math.min(
    MODAL_CLONE_FIRST_AUDIO_MAX_MS,
    Math.max(MODAL_CLONE_FIRST_AUDIO_MIN_MS, chosen)
  );
}

export type FirstAudioVerdict =
  | { trip: false; reason: "disabled" | "has_audio" | "within_budget" }
  | { trip: true; elapsedMs: number; budgetMs: number; message: string };

/**
 * Has this book run out of time to make its first sound?
 *
 * `firstAudioAt` is when audio last became playable (the job's
 * `first_section_at`, or a segment already marked ready). `startedAt` is
 * when this tick began its first call. A book that already has audio is
 * never tripped: later calls are covered by the warm HTTP budget, because a
 * warm container is not compiling.
 */
export function firstAudioWatchdog(input: {
  firstAudioAt?: number | null;
  startedAt: number;
  now?: number;
  hasAudio?: boolean;
  budgetMs?: number;
}): FirstAudioVerdict {
  if (input.hasAudio || Number(input.firstAudioAt ?? 0) > 0) {
    return { trip: false, reason: "has_audio" };
  }
  const budgetMs = input.budgetMs ?? modalCloneFirstAudioBudgetMs();
  if (!(budgetMs > 0)) return { trip: false, reason: "disabled" };
  const now = input.now ?? Date.now();
  const elapsedMs = Math.max(0, now - input.startedAt);
  if (elapsedMs < budgetMs) return { trip: false, reason: "within_budget" };
  return {
    trip: true,
    elapsedMs,
    budgetMs,
    message: firstAudioTimeoutMessage(elapsedMs, budgetMs),
  };
}

/**
 * The line the job row carries.
 *
 * It has to be useful to the person waiting and honest about what happened:
 * the engine loaded, this book never got a section, the GPU was released,
 * and the book stopped. It must not suggest re-running the same dead wait.
 */
export function firstAudioTimeoutMessage(elapsedMs: number, budgetMs: number): string {
  const waited = Math.max(1, Math.round(elapsedMs / 1000));
  const budget = Math.max(1, Math.round(budgetMs / 1000));
  return (
    `The voice engine loaded but produced no audio within ${waited}s ` +
    `(limit ${budget}s). The GPU was released and this book stopped. ` +
    "Try again, or choose another voice."
  );
}

/**
 * Log line for the trip. Kept separate so the reason is searchable and the
 * numbers an operator needs (elapsed, budget, how much was staged, which
 * Modal call) are on one line.
 */
export function firstAudioTimeoutLog(input: {
  jobId: string;
  elapsedMs: number;
  budgetMs: number;
  staged?: number;
  callId?: string | null;
}): string {
  const parts = [
    `[Job ${input.jobId}] first-audio watchdog tripped:`,
    `${Math.round(input.elapsedMs / 1000)}s with no section`,
    `limit ${Math.round(input.budgetMs / 1000)}s`,
    `staged=${input.staged ?? 0}`,
  ];
  if (input.callId) parts.push(`call=${input.callId}`);
  return parts.join(" ");
}

export type FirstAudioRace<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      elapsedMs: number;
      budgetMs: number;
      message: string;
      /** The container had reported itself restored before the clock ran out. */
      sawReady: boolean;
    };

/**
 * Run this book's first call under the first-audio clock.
 *
 * The call keeps whatever HTTP wait it was planned with; this race only
 * decides when to stop waiting for *any* audio. It trips on one condition:
 *
 *   no first audio **and** a container has reported itself restored.
 *
 * That second half matters. A pool with nothing placeable is not a stall,
 * and it already has its own answer (`deferForColdClonePool`, then the
 * documented Fish fallback). Failing a book early because Modal had no
 * capacity would turn a queue into a loss, so an unproven pool never trips
 * this. A restored container that then produces nothing is the
 * 2026-11-22 case, and that is exactly what this catches.
 *
 * On a trip the caller cancels the stored Modal call, which is what actually
 * releases the H100. This function does not abort the fetch: the render is
 * not plumbed a signal here, and cancelling the FunctionCall is the stronger
 * action anyway — it stops the work, not just our wait for it.
 */
export async function raceFirstAudio<T>(input: {
  run: () => Promise<T>;
  /** Strict readiness: true only when a container finished restoring. */
  probe: () => Promise<{ ready: boolean; warmContainers: number }>;
  startedAt: number;
  hasAudio: boolean;
  firstAudioAt?: number | null;
  budgetMs?: number;
  pollMs?: number;
  now?: () => number;
}): Promise<FirstAudioRace<T>> {
  const budgetMs = input.budgetMs ?? modalCloneFirstAudioBudgetMs();
  const decided = firstAudioWatchdog({
    firstAudioAt: input.firstAudioAt,
    startedAt: input.startedAt,
    hasAudio: input.hasAudio,
    budgetMs,
  });
  // A book that already has audio, or a disabled clock, is just the call.
  // Note that an *already expired* clock is not early-returned: it still has
  // to wait for a readiness proof, which the race below obtains.
  if (decided.trip === false && (decided.reason === "has_audio" || decided.reason === "disabled")) {
    return { ok: true, value: await input.run() };
  }

  const clock = input.now ?? Date.now;
  const pollMs = Math.max(
    1,
    pollForTests ?? input.pollMs ?? MODAL_CLONE_WATCHDOG_POLL_MS
  );
  let sawReady = false;
  let resolveTrip: ((trip: FirstAudioRace<T>) => void) | null = null;

  const call = input.run();
  // The call's own rejection is handed back through the race, which is the
  // same promise the caller awaited before this module existed.
  call.catch(() => undefined);

  const trip = new Promise<FirstAudioRace<T>>((resolve) => {
    resolveTrip = resolve;
  });

  const tick = async (): Promise<void> => {
    try {
      const state = await input.probe();
      if (state.ready && state.warmContainers > 0) sawReady = true;
    } catch {
      // A probe that cannot answer proves nothing. The clock keeps running,
      // and a later probe can still latch readiness.
    }
    const verdict = firstAudioWatchdog({
      firstAudioAt: input.firstAudioAt,
      startedAt: input.startedAt,
      hasAudio: input.hasAudio,
      budgetMs,
      now: clock(),
    });
    if (!verdict.trip) return;
    // Only a container that proved it restored can be "silent". Until then
    // this is a cold pool, which parks and eventually falls back.
    if (!sawReady) return;
    resolveTrip?.({
      ok: false,
      elapsedMs: verdict.elapsedMs,
      budgetMs: verdict.budgetMs,
      message: verdict.message,
      sawReady,
    });
  };

  const timer = setInterval(() => {
    void tick();
  }, pollMs);
  try {
    // Read readiness immediately, so a container that restored before this
    // call is latched rather than assumed.
    void tick();
    return await Promise.race([
      call.then((value) => ({ ok: true as const, value })),
      trip,
    ]);
  } finally {
    clearInterval(timer);
  }
}
