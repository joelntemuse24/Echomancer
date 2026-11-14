/**
 * What a clone batch may assume about the container that will serve it.
 *
 * `inline` is a container that returns each row's MP3 as `audio_b64`, so a page
 * has to stay under the 80 MiB JSON ceiling. `r2` is a container that uploads
 * each MP3 and returns `storage_key`, which removes that ceiling — but not the
 * row ceiling, which is the container's own `S2C_MAX_BATCH_ITEMS`.
 *
 * Both facts come from `GET /ready`; neither is inferred from a deploy date.
 * The rules matter because the worker and the Modal app ship separately:
 *
 * - A worker running this code against the **live v9 container** sees no
 *   `audio_transport` and no `max_batch_items`, so it keeps planning ≤ 24
 *   inline rows — exactly what that container accepts.
 * - Only after the new app is deployed and `/ready` reports both
 *   `audio_transport: "r2"` **and** `max_batch_items >= 32` does the planner
 *   widen a steady page to 32 rows. A worker that guessed 32 against v9 would
 *   collect `422 batch_too_large` on every full page.
 * - A cold pool reports nothing, so the last note stands rather than resetting
 *   to "inline" and re-planning a book at half width every time it parks.
 */

export type ModalCloneAudioTransport = "inline" | "r2";

/** Rows the deployed v9 container accepts, and the safe default. */
export const MODAL_CLONE_INLINE_BATCH_ROWS = 24;
/** Rows this build's container can accept; the planner's ceiling. */
export const MODAL_CLONE_MAX_BATCH_ROWS = 32;

let notedTransport: ModalCloneAudioTransport = "inline";
let notedMaxBatchItems = 0;

export function noteModalCloneAudioTransport(value: unknown): void {
  notedTransport = value === "r2" ? "r2" : "inline";
}

/**
 * Record the row cap `/ready` reported.
 *
 * Only an `r2` build's number is kept: an inline container's cap is a base64
 * body limit, not a row limit, and planning against it would be a second
 * ceiling that disagrees with {@link cloneBatchHttpBytes}.
 */
export function noteModalCloneMaxBatchItems(value: unknown): void {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    notedMaxBatchItems = 0;
    return;
  }
  notedMaxBatchItems = Math.min(MODAL_CLONE_MAX_BATCH_ROWS, Math.floor(n));
}

export function resetModalCloneAudioTransportForTests(): void {
  notedTransport = "inline";
  notedMaxBatchItems = 0;
}

export function modalCloneAudioTransport(
  env: NodeJS.ProcessEnv = process.env
): ModalCloneAudioTransport {
  const raw = (env.MODAL_S2_AUDIO_TRANSPORT ?? "").trim();
  if (raw === "r2" || raw === "inline") return raw;
  return notedTransport;
}

/** The row cap `/ready` reported, or 0 when no r2 build has answered yet. */
export function modalCloneReportedMaxBatchItems(): number {
  return notedMaxBatchItems;
}

/**
 * Rows one call may carry, given what the container has told us.
 *
 * 32 needs **both** facts: an `r2` page (so the JSON body is keys) and a
 * container that says it accepts 32. Either one missing leaves the deployed
 * v9 ceiling of 24 in place, which is what makes a worker-first deploy safe.
 * `MODAL_S2_BATCH_SIZE` still overrides everything, and never exceeds 32.
 */
export function modalCloneBatchRowsForTransport(
  env: NodeJS.ProcessEnv = process.env
): number {
  const pinned = Number(env.MODAL_S2_BATCH_SIZE);
  if (Number.isFinite(pinned) && pinned > 0) {
    return Math.min(MODAL_CLONE_MAX_BATCH_ROWS, Math.floor(pinned));
  }
  if (
    modalCloneAudioTransport(env) === "r2" &&
    modalCloneReportedMaxBatchItems() >= MODAL_CLONE_MAX_BATCH_ROWS
  ) {
    return MODAL_CLONE_MAX_BATCH_ROWS;
  }
  return MODAL_CLONE_INLINE_BATCH_ROWS;
}
