export type ClonePreviewRead = "audio" | "preparing" | "failed";

/**
 * Waits between re-reading storage after one Fish bake was enqueued.
 * Each step is longer than the last, and the list ends. A poll does not
 * start another render.
 */
export const CLONE_PREVIEW_POLL_MS = [2_000, 4_000, 8_000, 12_000] as const;

/** `202 PREVIEW_PREPARING` is a bake in progress. `409 PREVIEW_BAKE_FAILED` is terminal. */
export function classifyClonePreviewRead(
  status: number,
  code?: string | null
): ClonePreviewRead {
  if (code === "PREVIEW_BAKE_FAILED" || status === 409) return "failed";
  if (status === 202 || code === "PREVIEW_PREPARING") return "preparing";
  if (status >= 200 && status < 300) return "audio";
  return "failed";
}

/** Visible caption beside the spinner while a clone sample is baking. */
export const PREVIEW_PREPARING_LABEL = "Preparing preview…";

export type PreviewControl = "play" | "preparing" | "stop" | "retry";

export const PREVIEW_RETRY_LABEL = "Try again";

export function previewControl(input: {
  preparing: boolean;
  playing: boolean;
  failed?: boolean;
}): PreviewControl {
  if (input.preparing) return "preparing";
  if (input.failed) return "retry";
  if (input.playing) return "stop";
  return "play";
}

/**
 * What the row shows for one preview attempt.
 *
 * Play starts in `loading`. A stored clip stays there until audio starts.
 * `preparing` is only the answer to a 202: a Fish bake is actually running.
 */
export type ClonePreviewButtonState =
  | "preparing"
  | "loading"
  | "playing"
  | "failed"
  | "play";

export function clonePreviewButtonState(input: {
  preparing: boolean;
  loading: boolean;
  playing: boolean;
  failed?: boolean;
}): ClonePreviewButtonState {
  if (input.preparing) return "preparing";
  if (input.failed && !input.playing) return "failed";
  if (input.playing) return "playing";
  if (input.loading) return "loading";
  return "play";
}

/** The "Preparing preview…" caption. A spinner while a stored clip loads is not this. */
export function clonePreviewShowsPreparing(
  state: ClonePreviewButtonState
): boolean {
  return state === "preparing";
}

/**
 * Flags for the moment Play is pressed.
 * Loading is on. Preparing is not: the route has not answered yet.
 */
export function clonePreviewUiOnPlay(voiceId: string): {
  preparingId: null;
  loadingId: string;
  failedId: null;
} {
  return { preparingId: null, loadingId: voiceId, failedId: null };
}

/**
 * Flags after the preview route answers.
 * `audio` keeps the brief loading state. `preparing` is the 202 bake.
 */
export function clonePreviewUiAfterRead(
  voiceId: string,
  read: ClonePreviewRead
): { preparingId: string | null; loadingId: string | null; failedId: string | null } {
  if (read === "preparing") {
    return { preparingId: voiceId, loadingId: voiceId, failedId: null };
  }
  if (read === "audio") {
    return { preparingId: null, loadingId: voiceId, failedId: null };
  }
  return { preparingId: null, loadingId: null, failedId: voiceId };
}

/** Accessible name for the preview control. Preparing is not Stop. */
export function previewControlLabel(input: {
  preparing: boolean;
  playing: boolean;
  failed?: boolean;
  name: string;
}): string {
  const control = previewControl(input);
  if (control === "preparing") return `Preparing ${input.name}`;
  if (control === "retry") return `Try ${input.name} again`;
  if (control === "stop") return `Stop ${input.name}`;
  return `Play ${input.name}`;
}

/**
 * Preparing belongs to the attempt that showed it.
 * A failed token check clears that attempt. A late write from the same
 * attempt cannot put Preparing back once the token has moved. A newer
 * attempt that already owns the flag is left alone.
 */
export function clonePreparingAfterTokenCheck(input: {
  preparingId: string | null;
  voiceId: string;
  requestToken: number;
  activeToken: number;
  ownerToken: number;
  show: boolean;
}): { preparingId: string | null; ownerToken: number } {
  const stale = input.requestToken !== input.activeToken;
  const owns =
    input.ownerToken === input.requestToken && input.preparingId === input.voiceId;
  if (stale) {
    if (owns) return { preparingId: null, ownerToken: 0 };
    return { preparingId: input.preparingId, ownerToken: input.ownerToken };
  }
  if (input.show) {
    return { preparingId: input.voiceId, ownerToken: input.requestToken };
  }
  if (owns) return { preparingId: null, ownerToken: 0 };
  return { preparingId: input.preparingId, ownerToken: input.ownerToken };
}
