export type ClonePreviewRead = "audio" | "preparing" | "failed";

/** `202 PREVIEW_PREPARING` is a bake in progress. Anything else that is not audio failed. */
export function classifyClonePreviewRead(
  status: number,
  code?: string | null
): ClonePreviewRead {
  if (status === 202 || code === "PREVIEW_PREPARING") return "preparing";
  if (status >= 200 && status < 300) return "audio";
  return "failed";
}

export type PreviewControl = "play" | "preparing" | "stop";

export function previewControl(input: {
  preparing: boolean;
  playing: boolean;
}): PreviewControl {
  if (input.preparing) return "preparing";
  if (input.playing) return "stop";
  return "play";
}

/** Accessible name for the preview control. Preparing is not Stop. */
export function previewControlLabel(input: {
  preparing: boolean;
  playing: boolean;
  name: string;
}): string {
  const control = previewControl(input);
  if (control === "preparing") return `Preparing ${input.name}`;
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
