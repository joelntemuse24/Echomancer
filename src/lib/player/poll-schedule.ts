/**
 * A hidden tab does not poll, except while the listener is in the book.
 * Screen lock and a background tab would otherwise sit on the last section
 * until the next visit, because the following section only arrives on a poll.
 */
export function shouldPollJob(input: {
  visibility: "visible" | "hidden";
  playing: boolean;
  waitingForNext: boolean;
}): boolean {
  if (input.visibility !== "hidden") return true;
  return input.playing || input.waitingForNext;
}

/** Generating book: the interval before any audio is playable, and after a change. */
export const JOB_POLL_MIN_MS = 2_000;
/** Generating book: slowest interval while audio is playable and nothing changes. */
export const JOB_POLL_MAX_MS = 20_000;
const JOB_POLL_BACKOFF = 1.5;

/**
 * How long to wait before the next poll of a generating book.
 *
 * Before the first section can play there is nothing to gain from backing off:
 * the listener is staring at a spinner and the first audio is the only news.
 * Stay at the minimum interval until audio is playable, then stretch ×1.5 up
 * to the cap while nothing changes. Any change snaps back to the minimum.
 */
export function nextJobPollDelay(input: {
  delay: number;
  changed: boolean;
  hasPlayableAudio: boolean;
}): number {
  if (input.changed || !input.hasPlayableAudio) return JOB_POLL_MIN_MS;
  return Math.min(JOB_POLL_MAX_MS, Math.round(input.delay * JOB_POLL_BACKOFF));
}
