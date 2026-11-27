import { placeOnTimeline, type SectionSpan } from "@/lib/player/playback-position";
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

export type SnapshotContinue =
  | { action: "play"; index: number; path: string; localSeconds: number }
  | { action: "wait"; index: number }
  | { action: "ignore" };

/**
 * placeOnTimeline backs a playhead that landed on a boundary off by a
 * quarter second. A remaining sliver that small is the boundary, so the
 * next section plays. A real unpublished tail (about half a second) stays
 * on this section.
 */
const SNAPSHOT_TAIL_SECONDS = 0.35;

function snapshotSource(src: string | null | undefined): boolean {
  if (!src) return false;
  if (src.includes("/sections/") || src.startsWith("blob:") || src.includes("live.m3u8")) {
    return false;
  }
  return src.includes("/full.mp3");
}

function urlPath(url: string): string {
  return url.split("?")[0]?.split("#")[0] ?? url;
}

function queryValue(url: string, key: string): string | null {
  const query = url.split("?")[1]?.split("#")[0] ?? "";
  return new URLSearchParams(query).get(key);
}

/**
 * The rolling full.mp3 ended while the book is still generating. That file
 * is only the published prefix. Continue on the section that holds the
 * playhead, or the next section when the prefix ended on a boundary.
 */
export function continuePastPublishedPrefix(input: {
  src: string | null | undefined;
  endedAt: number;
  spans: readonly SectionSpan[];
  segments: Array<{ index: number; path: string; status: string }> | null | undefined;
  status: string | null | undefined;
}): SnapshotContinue {
  if (!snapshotSource(input.src)) return { action: "ignore" };
  if (input.status === "ready" || input.status === "failed" || input.status === "cancelled") {
    return { action: "ignore" };
  }
  const endedAt = Number.isFinite(input.endedAt) ? Math.max(0, input.endedAt) : 0;
  const placed = placeOnTimeline({ bookSeconds: endedAt, spans: input.spans });
  if (!placed) return { action: "wait", index: 0 };
  const span = input.spans.find((item) => item.index === placed.sectionIndex);
  const remaining = span ? span.durationSeconds - placed.localSeconds : 0;
  if (!span || remaining <= SNAPSHOT_TAIL_SECONDS) {
    const step = advanceAfterSection({
      segments: input.segments,
      from: placed.sectionIndex,
      status: input.status,
    });
    if (step.action === "play") {
      return { action: "play", index: step.index, path: step.path, localSeconds: 0 };
    }
    if (step.action === "wait") return { action: "wait", index: placed.sectionIndex };
    return { action: "ignore" };
  }
  const section = (input.segments ?? []).find(
    (segment) =>
      segment.index === placed.sectionIndex && segment.status === "ready" && segment.path
  );
  if (!section?.path) return { action: "wait", index: placed.sectionIndex };
  return {
    action: "play",
    index: section.index,
    path: section.path,
    localSeconds: placed.localSeconds,
  };
}

export type SnapshotHandoff =
  | { action: "stay" }
  | { action: "handoff"; url: string; at: number; play: boolean };

/**
 * The book is ready and the element is still the rolling snapshot. Point it
 * at the finished file at the same book time. A section file and a live
 * playlist have their own handoff.
 */
export function readySnapshotHandoff(input: {
  status: string | null | undefined;
  src: string | null | undefined;
  fullUrl: string | null;
  currentTime: number;
  playing: boolean;
}): SnapshotHandoff {
  if (input.status !== "ready" || !input.fullUrl || !snapshotSource(input.src)) {
    return { action: "stay" };
  }
  // Same object, including a cache-bust (`r`) on the finished file. A
  // rolling snapshot has no `v`, and the finished URL does.
  if (urlPath(input.src!) === urlPath(input.fullUrl)) {
    if (queryValue(input.src!, "v") === queryValue(input.fullUrl, "v")) {
      return { action: "stay" };
    }
  }
  const at =
    Number.isFinite(input.currentTime) && input.currentTime > 0 ? input.currentTime : 0;
  return { action: "handoff", url: input.fullUrl, at, play: input.playing };
}
