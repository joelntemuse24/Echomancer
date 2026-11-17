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
