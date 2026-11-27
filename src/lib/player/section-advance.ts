import { nextPlayableIndex } from "@/lib/tts/section-index";
import type { JobSegment } from "@/lib/tts/types";

export type SectionAdvance =
  | { action: "play"; index: number; path: string }
  | { action: "wait" }
  | { action: "stop" };

/**
 * What playback does when the current section file ends.
 *
 * A generating book waits at a hole so the listener does not hear the book
 * out of order. A finished book steps over a section that will never arrive.
 */
export function advanceAfterSection(input: {
  segments:
    | Array<{ index: number; path: string; status: string }>
    | null
    | undefined;
  from: number;
  status: string | null | undefined;
}): SectionAdvance {
  const segments = input.segments ?? [];
  const nextIndex = nextPlayableIndex(segments as JobSegment[], input.from, {
    skipUnavailable: input.status === "ready",
  });
  if (nextIndex == null) {
    if (input.status === "ready" || input.status === "failed" || input.status === "cancelled") {
      return { action: "stop" };
    }
    return { action: "wait" };
  }
  const next = segments.find(
    (segment) => segment.index === nextIndex && segment.status === "ready" && segment.path
  );
  if (!next?.path) {
    return input.status === "ready" ? { action: "stop" } : { action: "wait" };
  }
  return { action: "play", index: next.index, path: next.path };
}
