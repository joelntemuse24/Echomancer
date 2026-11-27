/**
 * A book that is still being joined is one MP3 that gets longer.
 * The element learns the new length only when it loads the file again.
 */

/** How close to the element's end a playhead has to be before a reload. */
const EDGE_SECONDS = 1.5;
/** Ignore a server length that is only a frame past the element. */
const GROW_SECONDS = 0.4;

export function growingFileDuration(
  elementDuration: number,
  reportedSeconds: number | null | undefined
): number {
  const element =
    Number.isFinite(elementDuration) && elementDuration > 0 ? elementDuration : 0;
  const reported =
    typeof reportedSeconds === "number" && Number.isFinite(reportedSeconds) && reportedSeconds > 0
      ? reportedSeconds
      : 0;
  return Math.max(element, reported);
}

/**
 * Reload the same object when the listener has reached the bytes this
 * element knows about and the server already has more.
 */
export function shouldRefreshGrowingFile(input: {
  complete: boolean;
  elementDuration: number;
  currentTime: number;
  reportedSeconds: number | null | undefined;
}): boolean {
  if (input.complete) return false;
  const element = input.elementDuration;
  const reported = input.reportedSeconds;
  if (!(element > 0) || typeof reported !== "number" || !(reported > element + GROW_SECONDS)) {
    return false;
  }
  return input.currentTime >= element - EDGE_SECONDS;
}

/** A seek target past the bytes loaded so far, still inside the joined file. */
export function seekPastLoadedFile(input: {
  elementDuration: number;
  targetSeconds: number;
  reportedSeconds: number | null | undefined;
}): boolean {
  const element = input.elementDuration;
  const reported = growingFileDuration(element, input.reportedSeconds);
  if (!(element > 0) || !(input.targetSeconds > element + 0.05)) return false;
  return input.targetSeconds <= reported + 0.05;
}
