import { isPlayInterruption } from "@/lib/preview-audio";

/**
 * What the main Play control should do with the audio element right now.
 *
 * `audio.play()` is not a reliable "start" signal, and treating it as one is
 * what left the transport dead at 0:00 in production. Two element states make
 * the promise useless:
 *
 *  - **Source selection already failed.** The element carries
 *    `HTMLMediaElement.error` (code 2/4) and `networkState === NETWORK_NO_SOURCE`.
 *    `play()` then rejects immediately with `NotSupportedError`, and no amount
 *    of tapping fixes it: nothing asks for the source again.
 *  - **Source selection is stalled.** The promise stays pending with no
 *    `play`, `canplay`, or `error` event, so elapsed time never moves and
 *    there is nothing to report.
 *
 * The Parts row recovers from both because it replaces `src` (or, when the
 * URL is unchanged, resets the playhead), which makes the browser select the
 * resource again. The transport has to do that itself: ask this module first,
 * and `"reload-and-play"` means "select the source again, then play".
 */
export type StartPlan = "play" | "reload-and-play" | "unavailable";

/** `HTMLMediaElement.networkState` when no source could be selected. */
const NETWORK_NO_SOURCE = 3;

/** `HTMLMediaElement.readyState` at which the element has data to play on. */
const HAVE_FUTURE_DATA = 3;

/** A playhead move smaller than this is not audible progress. */
const PLAYHEAD_EPSILON_SECONDS = 0.05;

/** One recovery load per start request. A second failure is reported. */
export const START_RECOVERY_LIMIT = 1;

/**
 * How long a start may stay silent before the player assumes the load is
 * stuck and selects the source again. Long enough to cover a cold
 * `/api/storage` 302 and a first byte range on a slow link; short enough that
 * a dead button is not left dead for the twelve seconds a listener waited.
 */
export const START_WATCHDOG_MS = 6_000;

/** Reported once a start cannot be recovered. */
export const START_FAILED_NOTICE = "Couldn't start this part. Try again.";

/** A blocked autoplay is the one rejection a second tap fixes outright. */
const RETRY_NOTICE = "Tap play again.";

/** The facts this module needs from `<audio>`, so it runs under vitest. */
export interface MediaSnapshot {
  paused: boolean;
  currentTime: number;
  /** 0–4, `HAVE_NOTHING` … `HAVE_ENOUGH_DATA`. */
  readyState: number;
  /** 0–3, `NETWORK_EMPTY` … `NETWORK_NO_SOURCE`. */
  networkState: number;
  /** `HTMLMediaElement.error.code`, or null. */
  errorCode: number | null;
  /**
   * Latest buffered end, in seconds. A long file can sit below
   * `HAVE_FUTURE_DATA` at 0:00 while this is still moving.
   */
  bufferedEnd: number;
}

export function mediaSnapshot(audio: {
  paused: boolean;
  currentTime: number;
  readyState: number;
  networkState: number;
  error?: { code: number } | null;
  buffered?: { length: number; end: (index: number) => number };
}): MediaSnapshot {
  let bufferedEnd = 0;
  const ranges = audio.buffered;
  if (ranges) {
    for (let i = 0; i < ranges.length; i++) {
      const end = ranges.end(i);
      if (Number.isFinite(end) && end > bufferedEnd) bufferedEnd = end;
    }
  }
  return {
    paused: audio.paused,
    currentTime: audio.currentTime,
    readyState: audio.readyState,
    networkState: audio.networkState,
    errorCode: audio.error?.code ?? null,
    bufferedEnd,
  };
}

/**
 * Pick what to do.
 *
 * `forceReload` is the watchdog's request: the element looked healthy but
 * nothing arrived, so the same socket must not simply be asked again. Both
 * paths stop at {@link START_RECOVERY_LIMIT}, after which the player says so
 * instead of tapping at a dead element.
 */
export function planStart(
  snapshot: MediaSnapshot,
  recoveryUsed: number,
  forceReload = false
): StartPlan {
  const failed =
    snapshot.errorCode != null || snapshot.networkState === NETWORK_NO_SOURCE;
  if (!failed && !forceReload) return "play";
  return recoveryUsed >= START_RECOVERY_LIMIT ? "unavailable" : "reload-and-play";
}

/**
 * True when a start request produced nothing audible in the watchdog window.
 *
 * `paused` cannot be the signal: the element reports `paused === false` from
 * the moment `play()` is called, before a single byte has been decoded. That
 * is exactly the production shape — the icon still reads Play, the clock still
 * reads 0:00, and `paused` is already false underneath. What is missing is
 * *progress*: the playhead has not moved past where the request began, and the
 * element has not reached `HAVE_FUTURE_DATA` (3).
 *
 * The playhead is compared with where it was when the request began, so a
 * start that resumes mid-section is judged on movement, not on being at 0:00.
 * A buffer that is still growing is movement too: a multi-hour file can sit
 * at 0:00 below `HAVE_FUTURE_DATA` while the first window arrives, and
 * reloading that element aborts a start that is working.
 */
export function startIsStuck(
  startedAt: MediaSnapshot,
  now: MediaSnapshot,
  waitedMs: number
): boolean {
  if (waitedMs < START_WATCHDOG_MS) return false;
  if (now.readyState >= HAVE_FUTURE_DATA) return false;
  // Bytes are still arriving. Reloading here aborts a healthy uncached
  // start, and that abort is reported as "Couldn't play this part."
  if (now.bufferedEnd > startedAt.bufferedEnd + PLAYHEAD_EPSILON_SECONDS) return false;
  return now.currentTime <= startedAt.currentTime + PLAYHEAD_EPSILON_SECONDS;
}

/**
 * The quiet line to show for a rejected `play()`, or null when the rejection
 * only means the player itself superseded the request (a newer load, a
 * section switch, our own pause). `preview-audio.ts` owns that distinction
 * for voice samples; the player reuses it so an interruption is still never
 * surfaced as an error.
 */
export function startFailureNotice(error: unknown): string | null {
  if (isPlayInterruption(error)) return null;
  const name =
    error && typeof error === "object"
      ? (error as { name?: unknown }).name
      : undefined;
  if (name === "NotAllowedError") return RETRY_NOTICE;
  return START_FAILED_NOTICE;
}
